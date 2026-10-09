@echo off
rem Builds the ESP32-S3 firmware with ESP-IDF, and optionally flashes it.
rem Run it from the "ESP-IDF Command Prompt" shortcut so IDF_PATH and the
rem ESP-IDF Python are set up.
rem   build_firmware.bat          build only
rem   build_firmware.bat COM7     build, then flash to COM7
setlocal

if "%IDF_PATH%"=="" (
    echo IDF_PATH is not set. Open the ESP-IDF Command Prompt first.
    exit /b 1
)

pushd "%~dp0"
python "%IDF_PATH%\tools\idf.py" build
if not "%ERRORLEVEL%"=="0" goto done
if not "%~1"=="" python "%IDF_PATH%\tools\idf.py" -p "%~1" flash

:done
set RC=%ERRORLEVEL%
popd
exit /b %RC%
