@echo off
rem custos_h264 を Release でビルドし、Unity パッケージの Plugins へ DLL を置く。
rem 使い方: native\custos-h264\build.cmd   (Visual Studio 2022 Build Tools が必要)
setlocal
set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
for /f "usebackq delims=" %%i in (`"%VSWHERE%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do set "VSDIR=%%i"
if not defined VSDIR (echo Visual Studio C++ build tools not found & exit /b 1)
set "CMAKE=%VSDIR%\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe"
set "HERE=%~dp0"
"%CMAKE%" -S "%HERE%." -B "%HERE%build" -G "Visual Studio 17 2022" -A x64 || exit /b 1
"%CMAKE%" --build "%HERE%build" --config Release || exit /b 1
set "DEST=%HERE%..\..\unity\com.ludiars.custos-bridge\Runtime\Plugins\x86_64"
if not exist "%DEST%" mkdir "%DEST%"
copy /y "%HERE%build\Release\custos_h264.dll" "%DEST%\custos_h264.dll" >nul || exit /b 1
echo built: %DEST%\custos_h264.dll
