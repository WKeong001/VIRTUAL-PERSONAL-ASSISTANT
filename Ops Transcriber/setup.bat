@echo off
setlocal
cd /d "%~dp0"

set "MODEL_NAME=Llama-3.2-3B-Instruct-Q4_0.gguf"
set "MODEL_DIR=%CD%\models"
set "MODEL_PATH=%MODEL_DIR%\%MODEL_NAME%"
set "MODEL_RELEASE_REPOSITORY=WKeong001/VIRTUAL-PERSONAL-ASSISTANT"

where py >nul 2>&1
if errorlevel 1 (
    echo Python 3.10, 3.11, or 3.12 is required.
    echo Install it from https://www.python.org/downloads/windows/ and select "Add Python to PATH".
    pause
    exit /b 1
)

set "PYTHON_COMMAND="
for %%V in (3.12 3.11 3.10) do (
    if not defined PYTHON_COMMAND (
        py -%%V -c "import sys" >nul 2>&1
        if not errorlevel 1 set "PYTHON_COMMAND=py -%%V"
    )
)

if not defined PYTHON_COMMAND (
    echo Python 3.10, 3.11, or 3.12 is required.
    echo Install a supported Python version, then run this file again.
    pause
    exit /b 1
)

if not exist ".venv\Scripts\python.exe" (
    echo Creating the Python environment...
    %PYTHON_COMMAND% -m venv .venv
    if errorlevel 1 (
        echo Failed to create the Python environment.
        pause
        exit /b 1
    )
)

echo Installing Python dependencies...
".venv\Scripts\python.exe" -m pip install --upgrade pip
if errorlevel 1 (
    echo Failed to update pip.
    pause
    exit /b 1
)
".venv\Scripts\python.exe" -m pip install -r requirements.txt
if errorlevel 1 (
    echo Failed to install the Python dependencies.
    pause
    exit /b 1
)

where node >nul 2>&1
if errorlevel 1 (
    echo Node.js 18 or newer is required.
    echo Install the current LTS version from https://nodejs.org/ and run this file again.
    pause
    exit /b 1
)

if not exist "node_modules\express" (
    echo Installing web dependencies...
    call npm ci
    if errorlevel 1 (
        echo Failed to install the web dependencies.
        pause
        exit /b 1
    )
)

if not exist "%MODEL_DIR%" mkdir "%MODEL_DIR%"
rem A ZIP download from GitHub contains only a tiny Git LFS pointer instead of the real model.
if exist "%MODEL_PATH%" for %%F in ("%MODEL_PATH%") do if %%~zF LSS 1000000 (
    echo The AI model file is only a Git LFS placeholder. Downloading the real model...
    del /f /q "%MODEL_PATH%"
)
if not exist "%MODEL_PATH%" (
    echo Downloading the AI model ^(about 1.9 GB^). This may take several minutes...
    powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'; $repo = '%MODEL_RELEASE_REPOSITORY%'; $modelName = '%MODEL_NAME%'; $headers = @{ 'User-Agent' = 'Ops-Transcriber-Setup' }; $destination = Join-Path (Get-Location) ('models\' + $modelName); $url = $null; try { $release = Invoke-RestMethod -Headers $headers -Uri ('https://api.github.com/repos/' + $repo + '/releases/latest'); $asset = @($release.assets) | Where-Object { $_.name -eq $modelName } | Select-Object -First 1; if ($asset) { $url = $asset.browser_download_url } } catch { }; if (-not $url) { $url = 'https://media.githubusercontent.com/media/' + $repo + '/main/Ops%%20Transcriber/models/' + $modelName }; Write-Host ('Source: ' + $url); $temporary = $destination + '.download'; Invoke-WebRequest -UseBasicParsing -Headers $headers -Uri $url -OutFile $temporary; if ((Get-Item $temporary).Length -lt 1000000) { Remove-Item -Force $temporary; throw 'Downloaded file is not a valid model.' }; Move-Item -Force $temporary $destination"
    if errorlevel 1 (
        echo Failed to download the AI model. Check the internet connection, or download %MODEL_NAME% manually into the models folder.
        pause
        exit /b 1
    )
)

echo Setup complete.
exit /b 0
