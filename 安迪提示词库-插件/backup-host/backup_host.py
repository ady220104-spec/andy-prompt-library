# -*- coding: utf-8 -*-
# 安迪提示词库 · 硬盘备份助手（Chrome 本机消息，协议 v2）
#
# 扩展每次保存后把整库发过来，这里写到备份目录：
#   <profile 目录>\最新.json            —— 始终是最新一份
#   <profile 目录>\每日\YYYY-MM-DD.json —— 每天一份，保留 90 天
#   <profile 目录>\条数变少前\*.json     —— 新数据比上一份少 3 条以上时，先把上一份留底再覆盖（最多留 30 份）
#   <profile 目录>\待导入\*.json         —— 反方向：放 JSON 进来，扩展读取并合并；扩展确认(ack)后才移到 已导入\
#
# 协议 v2（与 background.js 对齐）：
#   备份请求  {"prompts":[...], "profile":"<^[a-f0-9]{8,40}$>"}   profile 可省略（旧版兼容 = 根目录）
#   备份回包  {"version":2,"ok":true,"count":N,"dir":...,"profile":...,
#              "inbox":[{"name":"x.json","items":[...]}],"inboxSkipped":[...],
#              "warnings":[...],"py":...}
#   ack 请求  {"cmd":"ack","names":["x.json"],"profile":...}
#   ack 回包  {"version":2,"ok":true,"moved":[...],"dir":...,"profile":...,"warnings":[...],"py":...}
#   失败回包  {"version":2,"ok":false,"code":"backup_dir|not_registered|bad_profile|bad_request|empty|busy|internal","err":...}
#
# 多 Chrome profile：profiles.json 记录 profile -> 相对目录。
#   第一个出现的 profile 用 BACKUP_DIR 根目录（兼容老用户），后续 profile 用 BACKUP_DIR/profiles/<profile>/。
# inbox 两阶段：读取不移动文件；扩展合并成功后发 ack，才移动到 <profile 目录>\已导入\。
import glob
import json
import os
import re
import shutil
import struct
import sys
import tempfile
import time
import uuid
import errno
from contextlib import contextmanager

HERE = os.path.dirname(os.path.abspath(__file__))


def _read_backup_dir():
    # 登记脚本会把本文件复制到纯英文路径，并在旁边写 backup_dir.txt 指明备份位置。
    # backup_dir.txt 缺失 = 登记目录被清理工具删过一半：宁可让扩展报错，也不能静默回退到别的目录。
    try:
        with open(os.path.join(HERE, "backup_dir.txt"), encoding="utf-8-sig") as f:
            return f.read().strip()
    except OSError:
        return ""


BACKUP_DIR = _read_backup_dir()
KEEP_DAYS = 90
DROP_ALERT = 3
DROP_KEEP = 30
LOCK_TIMEOUT = 10.0
MAX_INBOX_FILES = 20
MAX_INBOX_BYTES = 512 * 1024
MAX_SINGLE_BYTES = 300 * 1024
MAX_SINGLE_ITEMS = 2000
PROFILES_FILE = "profiles.json"
PROFILE_RE = re.compile(r"^[a-f0-9]{8,40}$")
PY_INFO = "%s (%s)" % (sys.version.split()[0], sys.executable)


class ProfileError(Exception):
    pass


def _err(code, message, warnings=None, profile="", directory=""):
    return {"version": 2, "ok": False, "code": code, "err": message,
            "profile": profile, "dir": directory, "warnings": list(warnings or []), "py": PY_INFO}


@contextmanager
def backup_lock():
    """Windows 字节范围锁覆盖整次备份/ack；锁文件常驻，不能在解锁后删除。"""
    import msvcrt
    os.makedirs(BACKUP_DIR, exist_ok=True)
    with open(os.path.join(BACKUP_DIR, ".backup.lock"), "a+b") as lock:
        deadline = time.monotonic() + LOCK_TIMEOUT
        while True:
            lock.seek(0)
            try:
                # Windows 允许锁定 EOF 之外的字节，不需要并发初始化文件内容。
                msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
                break
            except OSError as e:
                if e.errno not in (errno.EACCES, errno.EAGAIN, errno.EDEADLK):
                    raise
                if time.monotonic() >= deadline:
                    raise TimeoutError("备份繁忙，等待其他进程超时，请稍后重试") from e
                time.sleep(0.02)
        try:
            yield
        finally:
            lock.seek(0)
            msvcrt.locking(lock.fileno(), msvcrt.LK_UNLCK, 1)


def read_msg():
    raw = sys.stdin.buffer.read(4)
    if len(raw) < 4:
        return None
    n = struct.unpack("<I", raw)[0]
    return json.loads(sys.stdin.buffer.read(n).decode("utf-8"))


def send_msg(obj):
    b = json.dumps(obj, ensure_ascii=False).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(b)))
    sys.stdout.buffer.write(b)
    sys.stdout.buffer.flush()


def write_atomic(path, text):
    tmp = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=os.path.dirname(path),
                                         prefix="." + os.path.basename(path) + ".", suffix=".tmp", delete=False) as f:
            tmp = f.name
            f.write(text)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    finally:
        if tmp is not None:
            try:
                os.remove(tmp)
            except FileNotFoundError:
                pass


def count_in(path, warnings):
    if not os.path.exists(path):
        return -1
    try:
        with open(path, encoding="utf-8") as f:
            d = json.load(f)
    except (OSError, ValueError) as e:
        warnings.append("上一份最新.json 无法读取（%s），本次跳过条数变少保护" % e)
        return -1
    if not isinstance(d, list):
        warnings.append("上一份最新.json 不是数组，本次跳过条数变少保护")
        return -1
    return len(d)


def _profiles_path():
    return os.path.join(BACKUP_DIR, PROFILES_FILE)


def _load_profiles(warnings):
    """返回 (profiles dict, readable)。readable=False 表示文件存在但读不出来。"""
    path = _profiles_path()
    try:
        with open(path, encoding="utf-8-sig") as f:
            d = json.load(f)
    except FileNotFoundError:
        return {}, True
    except ValueError as e:
        warnings.append("profiles.json 无法解析（%s），本次不改写它，临时使用 profiles/ 子目录" % e)
        return {}, False
    except OSError as e:
        warnings.append("profiles.json 读取失败（%s），本次不改写它" % e)
        return {}, False
    if isinstance(d, dict) and isinstance(d.get("profiles"), dict):
        return d["profiles"], True
    warnings.append("profiles.json 结构不认识，本次不改写它，临时使用 profiles/ 子目录")
    return {}, False


def _save_profiles(profiles, warnings):
    try:
        write_atomic(_profiles_path(), json.dumps({"version": 1, "profiles": profiles}, ensure_ascii=False, indent=1))
    except OSError as e:
        warnings.append("profiles.json 写入失败（%s），本次按临时目录继续" % e)


def _normalize_rel_dir(rel):
    """profiles.json 里只允许两种值：""（根目录）或 "profiles/<合法 profile>"。"""
    if rel == "":
        return ""
    if not isinstance(rel, str):
        return None
    parts = rel.split("/")
    if len(parts) == 2 and parts[0] == "profiles" and PROFILE_RE.match(parts[1]):
        return rel
    return None


def resolve_profile_dir(profile, create, warnings):
    """profile 为 "" 时按旧版兼容使用 BACKUP_DIR 根目录。"""
    if not profile:
        return BACKUP_DIR
    if not isinstance(profile, str) or not PROFILE_RE.match(profile):
        raise ProfileError("profile 格式不对（应匹配 ^[a-f0-9]{8,40}$）")
    profiles, readable = _load_profiles(warnings)
    rel = profiles.get(profile) if isinstance(profiles, dict) else None
    safe = _normalize_rel_dir(rel) if rel is not None else None
    if safe is None:
        if rel is not None:
            warnings.append("profiles.json 里 profile %s 的目录无效，已改用 profiles/%s" % (profile, profile))
            rel = "profiles/" + profile
        elif not profiles and readable:
            # 第一个出现的 profile：根目录（兼容老用户已有的 最新.json）
            rel = ""
        else:
            rel = "profiles/" + profile
        if create and readable:
            profiles = dict(profiles or {})
            profiles[profile] = rel
            _save_profiles(profiles, warnings)
    if rel == "":
        return BACKUP_DIR
    parts = rel.split("/")
    return os.path.join(BACKUP_DIR, *parts)


def _cleanup_daily(profile_dir, warnings):
    cutoff = time.time() - KEEP_DAYS * 86400
    for f in glob.glob(os.path.join(profile_dir, "每日", "*.json")):
        try:
            if os.path.getmtime(f) < cutoff:
                os.remove(f)
        except OSError as e:
            warnings.append("每日清理失败：%s（%s）" % (os.path.basename(f), e))


def _trim_drop(profile_dir, warnings):
    keep_dir = os.path.join(profile_dir, "条数变少前")
    entries = []
    for f in glob.glob(os.path.join(keep_dir, "*.json")):
        try:
            entries.append((os.path.getmtime(f), f))
        except OSError:
            continue
    if len(entries) <= DROP_KEEP:
        return
    entries.sort()
    for _, f in entries[:-DROP_KEEP]:
        try:
            os.remove(f)
        except OSError as e:
            warnings.append("条数变少留底清理失败：%s（%s）" % (os.path.basename(f), e))


def _extract_items(d):
    if isinstance(d, list):
        return d
    if isinstance(d, dict):
        for key in ("items", "prompts", "data"):
            v = d.get(key)
            if isinstance(v, list):
                return v
    return None


def read_inbox(profile_dir, warnings):
    """只读：返回 (inbox, inboxSkipped, warnings)，不移动任何文件。"""
    inbox = os.path.join(profile_dir, "待导入")
    if not os.path.isdir(inbox):
        try:
            os.makedirs(inbox, exist_ok=True)
        except OSError as e:
            warnings.append("待导入目录不可用：%s" % e)
            return [], []
    files = sorted(glob.glob(os.path.join(inbox, "*.json")))
    if len(files) > MAX_INBOX_FILES:
        warnings.append("待导入有 %d 个文件，本次只取前 %d 个，其余下次继续" % (len(files), MAX_INBOX_FILES))
        files = files[:MAX_INBOX_FILES]
    inbox_out = []
    skipped = []
    total_bytes = 0
    budget_full = False
    for f in files:
        name = os.path.basename(f)
        try:
            size = os.path.getsize(f)
        except OSError as e:
            warnings.append("待导入 %s 读取大小失败：%s" % (name, e))
            continue
        try:
            with open(f, encoding="utf-8-sig") as fh:
                d = json.load(fh)
        except (OSError, ValueError) as e:
            warnings.append("待导入 %s 无法解析（%s），未移动，请修正后重试" % (name, e))
            skipped.append({"name": name, "size": size, "count": -1})
            continue
        raw_items = _extract_items(d)
        if raw_items is None:
            warnings.append("待导入 %s 结构不认识（需要数组或含 items/prompts 的对象），未移动" % name)
            skipped.append({"name": name, "size": size, "count": -1})
            continue
        items = [x for x in raw_items if isinstance(x, dict)]
        if len(items) != len(raw_items):
            warnings.append("待导入 %s 含 %d 条非对象条目，已忽略" % (name, len(raw_items) - len(items)))
        count = len(items)
        if count <= 0:
            warnings.append("待导入 %s 没有有效条目，未移动" % name)
            skipped.append({"name": name, "size": size, "count": 0})
            continue
        if size > MAX_SINGLE_BYTES or count > MAX_SINGLE_ITEMS:
            warnings.append("待导入 %s 过大（%d 条 / %d 字节，单文件上限 %d 条 / %d 字节），已跳过，请拆分后重试"
                            % (name, count, size, MAX_SINGLE_ITEMS, MAX_SINGLE_BYTES))
            skipped.append({"name": name, "size": size, "count": count})
            continue
        ser = json.dumps(items, ensure_ascii=False).encode("utf-8")
        if total_bytes + len(ser) > MAX_INBOX_BYTES:
            warnings.append("待导入内容超过 %d KB，本次只返回前面的文件，其余下次继续" % (MAX_INBOX_BYTES // 1024))
            budget_full = True
            break
        total_bytes += len(ser)
        inbox_out.append({"name": name, "items": items})
    if budget_full and len(inbox_out) == 0:
        warnings.append("第一个待导入文件就超过 %d KB，已跳过本次导入；请拆分为更小文件" % (MAX_INBOX_BYTES // 1024))
    return inbox_out, skipped


def _ack_move(inbox, profile_dir, names, warnings):
    done = os.path.join(profile_dir, "已导入")
    inbox_real = os.path.realpath(inbox)
    moved = []
    for raw_name in names:
        if not isinstance(raw_name, str) or not raw_name:
            warnings.append("ack 名称无效，已忽略：%r" % (raw_name,))
            continue
        name = os.path.basename(raw_name)
        if (name != raw_name or name in (".", "..") or "\x00" in raw_name
                or not name.lower().endswith(".json") or ":" in name):
            warnings.append("ack 名称不安全，已忽略：%r" % (raw_name,))
            continue
        src = os.path.join(inbox, name)
        try:
            if os.path.dirname(os.path.realpath(src)) != inbox_real or not os.path.isfile(src):
                warnings.append("ack 文件不存在或不在待导入目录，已忽略：%s" % name)
                continue
            os.makedirs(done, exist_ok=True)
            target = os.path.join(done, time.strftime("%Y-%m-%d_%H%M%S-") + uuid.uuid4().hex + "-" + name)
            shutil.move(src, target)
            moved.append(name)
        except OSError as e:
            warnings.append("ack 移动 %s 失败（%s），文件仍留在待导入，可重试" % (name, e))
    return moved


def handle_backup(prompts, profile):
    warnings = []
    pdir = resolve_profile_dir(profile, True, warnings)
    try:
        os.makedirs(pdir, exist_ok=True)
        os.makedirs(os.path.join(pdir, "每日"), exist_ok=True)
    except OSError as e:
        return _err("backup_dir", "备份目录不可写：%s" % e, warnings, profile, pdir)
    latest = os.path.join(pdir, "最新.json")
    old_n = count_in(latest, warnings)
    stamp = time.strftime("%Y-%m-%d_%H%M%S") + "_%020d_" % time.time_ns() + uuid.uuid4().hex
    if old_n >= 0 and len(prompts) <= old_n - DROP_ALERT:
        try:
            keep = os.path.join(pdir, "条数变少前")
            os.makedirs(keep, exist_ok=True)
            shutil.copy2(latest, os.path.join(keep, "%s-%d条.json" % (stamp, old_n)))
        except OSError as e:
            warnings.append("条数变少留底失败（%s），继续覆盖最新.json" % e)
    text = json.dumps(prompts, ensure_ascii=False, indent=1)
    try:
        write_atomic(latest, text)
    except OSError as e:
        return _err("backup_dir", "最新.json 写入失败：%s" % e, warnings, profile, pdir)
    try:
        write_atomic(os.path.join(pdir, "每日", time.strftime("%Y-%m-%d") + ".json"), text)
    except OSError as e:
        return _err("backup_dir", "每日备份写入失败：%s" % e, warnings, profile, pdir)
    _cleanup_daily(pdir, warnings)
    _trim_drop(pdir, warnings)
    inbox, skipped = read_inbox(pdir, warnings)
    return {"version": 2, "ok": True, "count": len(prompts), "dir": pdir, "profile": profile,
            "inbox": inbox, "inboxSkipped": skipped, "warnings": warnings, "py": PY_INFO}


def handle_ack(msg, profile):
    names = msg.get("names")
    if not isinstance(names, list):
        return _err("bad_request", "ack 需要 names 数组", [], profile, "")
    warnings = []
    if not os.path.isdir(BACKUP_DIR):
        return _err("not_registered", "备份目录不存在（backup_dir.txt 指向的目录不可用）：重新运行登记脚本", [], profile, "")
    try:
        pdir = resolve_profile_dir(profile, False, warnings)
    except ProfileError as e:
        return _err("bad_profile", str(e), warnings, profile, "")
    inbox = os.path.join(pdir, "待导入")
    if not os.path.isdir(inbox):
        return {"version": 2, "ok": True, "moved": [], "dir": pdir, "profile": profile, "warnings": warnings, "py": PY_INFO}
    try:
        with backup_lock():
            moved = _ack_move(inbox, pdir, names, warnings)
    except TimeoutError as e:
        return _err("busy", str(e), warnings, profile, pdir)
    except OSError as e:
        return _err("backup_dir", "ack 写盘失败：%s" % e, warnings, profile, pdir)
    return {"version": 2, "ok": True, "moved": moved, "dir": pdir, "profile": profile, "warnings": warnings, "py": PY_INFO}


def handle(msg):
    if not isinstance(msg, dict):
        return _err("bad_request", "消息格式不对（需要 JSON 对象）")
    if not BACKUP_DIR:
        return _err("not_registered", "备份目录没登记（backup_dir.txt 缺失）：重新运行 backup-host\\登记备份助手.ps1 一次")
    profile = msg.get("profile", "")
    if profile is None:
        profile = ""
    if not isinstance(profile, str):
        return _err("bad_profile", "profile 必须是字符串")
    if profile and not PROFILE_RE.match(profile):
        return _err("bad_profile", "profile 格式不对（应匹配 ^[a-f0-9]{8,40}$）")
    cmd = msg.get("cmd")
    if cmd == "ack":
        return handle_ack(msg, profile)
    if cmd is not None:
        return _err("bad_request", "未知命令：%s" % cmd, [], profile, "")
    prompts = msg.get("prompts")
    if not isinstance(prompts, list) or not prompts:
        return _err("empty", "空数据，不写", [], profile, "")
    try:
        os.makedirs(BACKUP_DIR, exist_ok=True)
    except OSError as e:
        return _err("backup_dir", "备份目录不可用：%s" % e, [], profile, "")
    try:
        with backup_lock():
            return handle_backup(prompts, profile)
    except TimeoutError as e:
        return _err("busy", str(e), [], profile, "")
    except ProfileError as e:
        return _err("bad_profile", str(e), [], profile, "")
    except OSError as e:
        return _err("backup_dir", "备份目录写入失败：%s" % e, [], profile, "")


def main():
    try:
        msg = read_msg()
        if msg is None:
            return
        send_msg(handle(msg))
    except Exception as e:
        try:
            send_msg({"version": 2, "ok": False, "code": "internal", "err": str(e), "py": PY_INFO})
        except Exception:
            pass


if __name__ == "__main__":
    main()
