@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo  ======================================
echo    MANOVA Store - جاري تشغيل المتجر...
echo  ======================================
echo.
echo   المتجر:        http://localhost:3000
echo   لوحة التحكم:   http://localhost:3000/admin
echo.
echo   لإيقاف المتجر اقفل النافذة دي أو اضغط Ctrl+C
echo.
start "" cmd /c "timeout /t 2 >nul & start http://localhost:3000"
node server.js
pause
