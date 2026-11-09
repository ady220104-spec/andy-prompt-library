# =============================================================
# 安迪提示词库 · 备份助手登记与自检（协议 v2）
#
# 用法（在资源管理器里右键本文件 ->「使用 PowerShell 运行」，或由 修复备份.cmd 调用）：
#   登记备份助手.ps1                      # 用「当前扩展目录」自动推导扩展 ID 并登记
#   登记备份助手.ps1 -ExtId <32位a-p>     # 明确指定扩展 ID（换过目录/商店安装时）
#   登记备份助手.ps1 -BackupDir <目录>    # 指定备份目录（默认：扩展目录上一级的 安迪提示词库-备份）
#   登记备份助手.ps1 -DryRun              # 只读检查：打印将要做什么 / 当前状态，不写任何文件或注册表
#
# 要点：
# * 扩展 ID 不是随便写的常量：未打包扩展的 ID = SHA256(扩展目录绝对路径的 UTF-16LE 字节) 前 16 字节，
#   每个半字节 0-f 映射为 a-p。所以换目录/换电脑后 ID 会变，必须重新推导（本脚本自动做）。
# * 自检逐项 PASS/FAIL：源文件、manifest 字段、allowed_origins、注册表回读、备份目录可写、协议探针。
#   任一 FAIL 以非零退出码结束，修复备份.cmd 会据此显示失败原因。
# * 备份/ack 协议 v2 由 backup_host.py 实现；本脚本只负责复制、登记与自检。
# =============================================================
param(
    [string]$ExtId = '',
    [string]$BackupDir = '',
    [switch]$DryRun
)
$ErrorActionPreference = 'Stop'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$extDir = Split-Path -Parent $here
$utf8 = New-Object System.Text.UTF8Encoding($false)

$script:passCount = 0
$script:failCount = 0
$script:skipCount = 0

function Write-Pass([string]$Name, [string]$Detail) {
    $script:passCount++
    if ($Detail) { Write-Output ("PASS  " + $Name + "  (" + $Detail + ")") } else { Write-Output ("PASS  " + $Name) }
}
function Write-Fail([string]$Name, [string]$Detail) {
    $script:failCount++
    Write-Output ("FAIL  " + $Name + "  - " + $Detail)
}
function Write-Skip([string]$Name, [string]$Detail) {
    $script:skipCount++
    if ($Detail) { Write-Output ("SKIP  " + $Name + "  (" + $Detail + ")") } else { Write-Output ("SKIP  " + $Name) }
}
function Get-ExtensionIdFromPath([string]$Path) {
    $full = [System.IO.Path]::GetFullPath($Path)
    if ($full.Length -gt 3) { $full = $full.TrimEnd('\', '/') }
    $bytes = [System.Text.Encoding]::Unicode.GetBytes($full)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { $hash = $sha.ComputeHash($bytes) } finally { $sha.Dispose() }
    $sb = New-Object System.Text.StringBuilder
    for ($i = 0; $i -lt 16; $i++) {
        $b = [int]$hash[$i]
        [void]$sb.Append([char](97 + (($b -shr 4) -band 0x0F)))
        [void]$sb.Append([char](97 + ($b -band 0x0F)))
    }
    return $sb.ToString()
}
function Read-FramedReply([string]$BatPath) {
    $probe = '{"prompts":[]}'
    $pb = [System.Text.Encoding]::UTF8.GetBytes($probe)
    $msg = New-Object byte[] (4 + $pb.Length)
    [Array]::Copy([BitConverter]::GetBytes([uint32]$pb.Length), 0, $msg, 0, 4)
    [Array]::Copy($pb, 0, $msg, 4, $pb.Length)
    $tag = [guid]::NewGuid().ToString('N')
    $inFile = Join-Path $env:TEMP ("andy-probe-" + $tag + ".in")
    $outFile = Join-Path $env:TEMP ("andy-probe-" + $tag + ".out")
    $errFile = Join-Path $env:TEMP ("andy-probe-" + $tag + ".err")
    [System.IO.File]::WriteAllBytes($inFile, $msg)
    $result = [ordered]@{ ok = $false; reply = ''; stderr = ''; exitCode = -1; detail = '' }
    try {
        $p = Start-Process -FilePath $BatPath -RedirectStandardInput $inFile -RedirectStandardOutput $outFile -RedirectStandardError $errFile -NoNewWindow -Wait -PassThru
        $result.exitCode = $p.ExitCode
        $raw = [System.IO.File]::ReadAllBytes($outFile)
        if ($raw.Length -ge 4) {
            $n = [BitConverter]::ToUInt32($raw, 0)
            if ($raw.Length -eq (4 + [int]$n)) {
                $reply = [System.Text.Encoding]::UTF8.GetString($raw, 4, [int]$n)
                $result.reply = $reply
                try {
                    $obj = $reply | ConvertFrom-Json
                    if ($obj -and ($obj.version -eq 2)) { $result.ok = $true }
                    else { $result.detail = '回复 JSON 缺少 version=2：' + $reply }
                } catch { $result.detail = '回复不是合法 JSON：' + $reply }
            } else {
                $result.detail = 'stdout 帧长度不符（可能混入非协议输出）：收到 ' + $raw.Length + ' 字节，声明 ' + $n
            }
        } else {
            $result.detail = 'stdout 没有协议回包（收到 ' + $raw.Length + ' 字节）'
        }
        if (Test-Path -LiteralPath $errFile) {
            $result.stderr = ((Get-Content -LiteralPath $errFile -Raw) -replace "\r?\n", ' ').Trim()
        }
    } catch {
        $result.detail = $_.Exception.Message
    } finally {
        Remove-Item -LiteralPath $inFile, $outFile, $errFile -Force -ErrorAction SilentlyContinue
    }
    return $result
}

Write-Output '================================================================'
Write-Output ' 安迪提示词库 · 备份助手登记与自检（协议 v2）'
if ($DryRun) { Write-Output ' 模式：DryRun（只读检查，不写任何文件/注册表）' } else { Write-Output ' 模式：实际登记' }
Write-Output (' 脚本目录：' + $here)
Write-Output (' 扩展目录：' + $extDir)
Write-Output '================================================================'

# ---- 1. 源文件 ----
$srcPy = Join-Path $here 'backup_host.py'
$srcBat = Join-Path $here 'backup_host.bat'
if ((Test-Path -LiteralPath $srcPy) -and (Test-Path -LiteralPath $srcBat)) {
    Write-Pass '源文件存在（backup_host.py / backup_host.bat）' $here
} else {
    Write-Fail '源文件存在' 'backup-host 目录下缺 backup_host.py 或 backup_host.bat'
}

# ---- 2. 扩展 ID ----
$idSource = '未确定'
if ($ExtId) {
    if ($ExtId -match '^[a-p]{32}$') {
        Write-Pass '扩展 ID（-ExtId 参数）' $ExtId
        $idSource = '参数'
    } else {
        Write-Fail '扩展 ID 格式' '-ExtId 必须是 32 位 a-p（例如用 chrome://extensions 里显示的 ID）'
        $ExtId = ''
    }
} else {
    try {
        $computed = Get-ExtensionIdFromPath $extDir
        if ($computed -match '^[a-p]{32}$') {
            Write-Pass '扩展 ID 自动推导' $computed
            $ExtId = $computed
            $idSource = '自动推导'
        } else {
            Write-Fail '扩展 ID 自动推导' ('结果不合法：' + $computed)
        }
    } catch {
        Write-Fail '扩展 ID 自动推导' $_.Exception.Message
    }
}

# ---- 3. 备份目录路径 ----
$backupPath = ''
try {
    if (-not $BackupDir) {
        $backupPath = [System.IO.Path]::GetFullPath((Join-Path $here '..\..\安迪提示词库-备份'))
    } elseif ([System.IO.Path]::IsPathRooted($BackupDir)) {
        $backupPath = [System.IO.Path]::GetFullPath($BackupDir)
    } else {
        $backupPath = [System.IO.Path]::GetFullPath((Join-Path $extDir $BackupDir))
    }
    Write-Pass '备份目录路径' $backupPath
} catch {
    Write-Fail '备份目录路径' $_.Exception.Message
}

# ---- 4. 备份目录可写（DryRun 不写文件，跳过）----
if ($DryRun) {
    Write-Skip '备份目录可写' 'DryRun 不写文件；实际运行会创建目录并写测试文件'
} elseif (-not $backupPath) {
    Write-Skip '备份目录可写' '备份目录路径无效'
} else {
    try {
        if (-not (Test-Path -LiteralPath $backupPath)) {
            New-Item -ItemType Directory -Force -Path $backupPath | Out-Null
        }
        if (-not (Test-Path -LiteralPath $backupPath -PathType Container)) {
            throw ('无法创建备份目录：' + $backupPath + '（所在盘不存在、路径被文件占用或没有权限）')
        }
        $writeProbe = Join-Path $backupPath ('.andy-write-test-' + [guid]::NewGuid().ToString('N'))
        [System.IO.File]::WriteAllText($writeProbe, 'ok', $utf8)
        Remove-Item -LiteralPath $writeProbe -Force
        Write-Pass '备份目录可写' $backupPath
    } catch {
        Write-Fail '备份目录可写' ('无法写入 ' + $backupPath + '：' + $_.Exception.Message)
    }
}

# ---- 5. APPDATA / 登记位置 ----
$appData = $env:APPDATA
$dst = ''
if ($appData) {
    $dst = Join-Path $appData 'AndyPromptBackup'
} else {
    Write-Fail 'APPDATA 环境变量' '取不到 %APPDATA%，无法登记'
}
$hostBat = ''
$hostJson = ''
if ($dst) {
    $hostBat = Join-Path $dst 'backup_host.bat'
    $hostJson = Join-Path $dst 'com.andy.prompt_backup.json'
}

# ---- 6. manifest 字段（内存校验，先于写盘）----
$expectedOrigin = ''
if ($ExtId) { $expectedOrigin = 'chrome-extension://' + $ExtId + '/' }
$manifest = [ordered]@{
    name = 'com.andy.prompt_backup'
    description = 'Andy prompt library disk backup'
    path = $hostBat
    type = 'stdio'
    allowed_origins = @($expectedOrigin)
}
if ($hostBat -and $ExtId -and ($manifest.name -eq 'com.andy.prompt_backup') -and ($manifest.type -eq 'stdio')) {
    Write-Pass 'manifest 字段（内存校验）' ('path=' + $hostBat)
} else {
    Write-Fail 'manifest 字段' 'name/type/path 不完整'
}
if ($expectedOrigin -and $ExtId -and ($manifest.allowed_origins.Count -eq 1) -and ($manifest.allowed_origins[0] -eq $expectedOrigin)) {
    Write-Pass 'allowed_origins 含当前扩展 ID' $expectedOrigin
} else {
    Write-Fail 'allowed_origins' '无法生成含当前扩展 ID 的 allowed_origins'
}

# ---- 提前失败：不写任何文件/注册表 ----
if ($script:failCount -gt 0) {
    Write-Output ''
    Write-Output ('自检汇总：PASS ' + $script:passCount + ' / FAIL ' + $script:failCount + ' / SKIP ' + $script:skipCount)
    Write-Output '结果：未通过（本次没有写入任何文件或注册表）'
    Write-Output '请按上面的 FAIL 修复后重新运行本脚本。'
    Start-Sleep -Seconds 5
    exit 1
}

$regKey = 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.andy.prompt_backup'

if ($DryRun) {
    # ---- DryRun：只读取/打印 ----
    Write-Skip '复制助手文件到 APPDATA' ('将复制到 ' + $dst)
    Write-Skip '写 backup_dir.txt' ('将写入 ' + $backupPath)
    Write-Skip '写 manifest' ('将写入 ' + $hostJson)
    $existing = ''
    try {
        $existingKey = Get-Item -Path $regKey -ErrorAction Stop
        $existing = [string]$existingKey.GetValue('')
    } catch { $existing = '' }
    if ($existing) {
        Write-Skip '写注册表' ('当前已登记：' + $existing)
    } else {
        Write-Skip '写注册表' '当前未登记（实际运行会写入）'
    }
    # 协议探针：直接跑源目录的启动器；输入是空数据，host 在写盘前返回，不碰备份目录
    $probe = Read-FramedReply $srcBat
    $probeObj = $null
    if ($probe.reply) { try { $probeObj = $probe.reply | ConvertFrom-Json } catch { } }
    if ($probe.ok -and $probeObj) {
        Write-Pass '协议探针（源目录，空数据不写盘）' ('code=' + $probeObj.code)
    } else {
        Write-Fail '协议探针' ($probe.detail + $(if ($probe.stderr) { '；stderr：' + $probe.stderr } else { '' }))
    }
    Write-Output ''
    Write-Output ('DryRun 汇总：PASS ' + $script:passCount + ' / FAIL ' + $script:failCount + ' / SKIP ' + $script:skipCount)
    if ($script:failCount -gt 0) {
        Write-Output '结果：DryRun 检查未通过（没有写任何东西）。'
        Start-Sleep -Seconds 5
        exit 1
    }
    Write-Output '结果：DryRun 检查通过。去掉 -DryRun 再运行即为实际登记。'
    Start-Sleep -Seconds 5
    exit 0
}

# ---- 实际登记 ----
try {
    New-Item -ItemType Directory -Force -Path $dst | Out-Null
    Copy-Item -LiteralPath $srcPy -Destination $dst -Force
    Copy-Item -LiteralPath $srcBat -Destination $dst -Force
    $copiedPy = Join-Path $dst 'backup_host.py'
    $copiedBat = Join-Path $dst 'backup_host.bat'
    if ((Test-Path -LiteralPath $copiedPy) -and (Test-Path -LiteralPath $copiedBat) -and ((Get-Item -LiteralPath $copiedBat).Length -gt 0) -and ((Get-Item -LiteralPath $copiedPy).Length -gt 0)) {
        Write-Pass '复制助手文件到 APPDATA' $dst
    } else {
        Write-Fail '复制助手文件到 APPDATA' ('复制后文件缺失或为空：' + $dst)
    }

    [System.IO.File]::WriteAllText((Join-Path $dst 'backup_dir.txt'), $backupPath, $utf8)
    $backRead = ([System.IO.File]::ReadAllText((Join-Path $dst 'backup_dir.txt'), [System.Text.Encoding]::UTF8)).Trim()
    if ($backRead -eq $backupPath) {
        Write-Pass '写 backup_dir.txt' $backupPath
    } else {
        Write-Fail '写 backup_dir.txt' ('回读不一致：' + $backRead)
    }

    [System.IO.File]::WriteAllText($hostJson, ($manifest | ConvertTo-Json -Depth 5), $utf8)
    $readBack = $null
    try { $readBack = Get-Content -LiteralPath $hostJson -Raw | ConvertFrom-Json } catch { }
    if ($readBack) {
        $origins = @($readBack.allowed_origins)
        $manifestOk = ($readBack.name -eq 'com.andy.prompt_backup') -and ($readBack.type -eq 'stdio') -and ($readBack.path -eq $hostBat) -and ($origins -contains $expectedOrigin)
        if ($manifestOk) {
            Write-Pass 'manifest JSON 回读' ('path=' + $readBack.path)
        } else {
            Write-Fail 'manifest JSON 回读' 'name/type/path/allowed_origins 与预期不符'
        }
    } else {
        Write-Fail 'manifest JSON 回读' 'manifest 文件无法解析'
    }

    $null = New-Item -Path $regKey -Force
    Set-ItemProperty -Path $regKey -Name '(default)' -Value $hostJson
    $regRead = ''
    try {
        $regItem = Get-Item -Path $regKey -ErrorAction Stop
        $regRead = [string]$regItem.GetValue('')
    } catch { $regRead = '' }
    if ($regRead -eq $hostJson) {
        Write-Pass '注册表回读 = manifest 路径' $regRead
    } else {
        Write-Fail '注册表回读' ('实际=' + $regRead + '，预期=' + $hostJson)
    }

    $probe = Read-FramedReply $copiedBat
    $probeObj = $null
    if ($probe.reply) { try { $probeObj = $probe.reply | ConvertFrom-Json } catch { } }
    if ($probe.ok -and $probeObj -and ($probeObj.code -eq 'empty')) {
        Write-Pass '协议探针（空数据回包，不写盘）' ('exit=' + [string]$probe.exitCode)
    } else {
        Write-Fail '协议探针' ($probe.detail + $(if ($probe.stderr) { '；stderr：' + $probe.stderr } else { '' }))
    }
} catch {
    Write-Fail '登记写入' $_.Exception.Message
}

Write-Output ''
Write-Output ('自检汇总：PASS ' + $script:passCount + ' / FAIL ' + $script:failCount + ' / SKIP ' + $script:skipCount)
if ($script:failCount -gt 0) {
    Write-Output '结果：未通过（见上面的 FAIL）。'
    Write-Output '常见原因：备份目录所在盘不存在/没权限；Python 3 没装或被卸载；manifest/注册表被安全软件拦截。'
    Start-Sleep -Seconds 5
    exit 1
}

Write-Output '结果：通过：备份助手已登记，且端到端自检成功。'
Write-Output ('扩展 ID：' + $ExtId + '（来源：' + $idSource + '）')
Write-Output ('备份目录：' + $backupPath)
Write-Output ''
Write-Output '现在去 chrome://extensions 刷新「安迪提示词库」，并关掉、重新打开侧边栏；'
Write-Output '然后右键工具栏上的插件图标 ->「重新备份提示词库到硬盘」（或打开侧边栏菜单点「备份：...」）。'
Write-Output '备份成功后红色的「!」会立刻消失。'
Write-Output '本窗口 5 秒后自动关闭。'
Start-Sleep -Seconds 5
exit 0
