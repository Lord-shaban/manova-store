@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo  ======================================
echo    MANOVA Store - معاينة محلية...
echo  ======================================
echo.
echo   المتجر:        http://localhost:3000
echo   لوحة التحكم:   http://localhost:3000/admin
echo.
echo   ملحوظة: المعاينة بتتصل بقاعدة بيانات Firebase
echo   لازم تكون مالي ملف public\js\firebase-config.js الأول
echo.
echo   لإيقاف المعاينة اقفل النافذة دي أو اضغط Ctrl+C
echo.
start "" cmd /c "timeout /t 2 >nul & start http://localhost:3000"
node scripts\dev-server.js
pause
