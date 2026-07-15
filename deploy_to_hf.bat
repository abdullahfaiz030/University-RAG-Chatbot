@echo off
REM Deploy to Hugging Face Spaces
REM Usage: deploy_to_hf.bat YOUR_HF_USERNAME

setlocal enabledelayedexpansion

if "%1"=="" (
    echo Usage: deploy_to_hf.bat YOUR_HF_USERNAME
    echo.
    echo Example: deploy_to_hf.bat looksa
    exit /b 1
)

set HF_USERNAME=%1
set HF_SPACE_NAME=university-chatbot
set HF_SPACE_URL=https://huggingface.co/spaces/%HF_USERNAME%/%HF_SPACE_NAME%

echo.
echo ========================================
echo Deploying to Hugging Face Spaces
echo ========================================
echo Space URL: %HF_SPACE_URL%
echo.

REM Check if git is installed
git --version >nul 2>&1
if errorlevel 1 (
    echo Error: Git is not installed. Please install Git first.
    echo Download from: https://git-scm.com/download/win
    exit /b 1
)

REM Check if git-lfs is installed
git lfs version >nul 2>&1
if errorlevel 1 (
    echo Warning: Git LFS is not installed. Installing Git LFS is recommended.
    echo Download from: https://git-lfs.github.com/
)

echo.
echo Step 1: Creating .gitignore for HF Spaces...
(
    echo .env
    echo __pycache__/
    echo *.pyc
    echo *.pyo
    echo .DS_Store
    echo chroma_db/
    echo uploads/
    echo *.log
    echo venv/
    echo .vscode/
    echo .idea/
    echo *.db
    echo *.sqlite
) > .gitignore

echo.
echo Step 2: Staging files for commit...
git add .

echo.
echo Step 3: Committing changes...
git commit -m "Deploy advanced chatbot to Hugging Face Spaces"

echo.
echo Step 4: Adding HF Spaces remote (if not exists)...
git remote remove hf-space 2>nul
git remote add hf-space https://huggingface.co/spaces/%HF_USERNAME%/%HF_SPACE_NAME%

echo.
echo Step 5: Pushing to Hugging Face Spaces...
echo Please enter your Hugging Face credentials when prompted.
echo (Use your HF token as password)
echo.

git push hf-space main

if errorlevel 1 (
    echo.
    echo Error: Push failed. Please check:
    echo 1. Your HF username is correct: %HF_USERNAME%
    echo 2. Space exists at: %HF_SPACE_URL%
    echo 3. Your HF token is valid
    echo.
    echo Troubleshooting:
    echo - Manually push with: git push -u hf-space main
    echo - Or authenticate with: git credential approve
    exit /b 1
)

echo.
echo ========================================
echo ✓ Deployment successful!
echo ========================================
echo.
echo Your chatbot is now deploying to:
echo %HF_SPACE_URL%
echo.
echo IMPORTANT: Configure these secrets in HF Spaces:
echo 1. Go to: %HF_SPACE_URL%/settings
echo 2. Click "Repository secrets"
echo 3. Add these variables:
echo    - GROQ_API_KEY = your_api_key
echo    - QDRANT_URL = your_qdrant_url
echo    - QDRANT_API_KEY = your_qdrant_key
echo    - ADMIN_PASSWORD = your_password
echo    - SECRET_KEY = random_string
echo.
echo The space will rebuild automatically.
echo Check the "Logs" tab for deployment status.
echo.
pause
