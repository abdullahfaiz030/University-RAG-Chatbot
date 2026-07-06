@echo off
REM Safe Push Script for Hugging Face Spaces (Windows)
REM This script pushes only necessary files without exposing secrets

setlocal enabledelayedexpansion

echo 🔐 Safe Push to Hugging Face Spaces
echo ====================================
echo.

REM Check if git is initialized
if not exist .git (
    echo ❌ Error: Not a git repository
    exit /b 1
)

echo 📋 Checking git status...
git status

echo.
echo ⚠️  Verifying no secrets will be pushed...

REM Check for dangerous patterns
git diff --cached --name-only | findstr /E "\.env _api_key _token _password imp\\" >nul
if !errorlevel! equ 0 (
    echo ❌ DANGER: Sensitive files detected in staging area!
    echo.
    echo Staged files with dangerous patterns:
    git diff --cached --name-only | findstr /E "\.env _api_key _token _password imp\\"
    echo.
    echo Please remove them:
    echo   git reset HEAD ^<filename^>
    exit /b 1
)

echo.
echo ✅ Safe files to push:
git diff --cached --name-only

echo.
set /p confirm="Continue with push? (y/N): "
if /i not "%confirm%"=="y" (
    echo Push cancelled.
    exit /b 0
)

echo.
echo 📤 Pushing to origin...
git push -u origin main

echo.
echo ✅ Push completed successfully!
echo.
echo 📝 Remember to update HF Spaces secrets:
echo   1. Go to Space Settings ^> Secrets and variables
echo   2. Update HF_TOKEN and other environment variables
echo   3. Restart the Space
