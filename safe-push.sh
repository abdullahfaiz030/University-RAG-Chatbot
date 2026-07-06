#!/bin/bash
# Safe Push Script for Hugging Face Spaces
# This script pushes only necessary files without exposing secrets

set -e  # Exit on error

echo "🔐 Safe Push to Hugging Face Spaces"
echo "===================================="
echo ""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check if git is initialized
if [ ! -d .git ]; then
    echo -e "${RED}❌ Error: Not a git repository${NC}"
    exit 1
fi

# Verify .gitignore is updated
if ! grep -q "imp/" .gitignore; then
    echo -e "${RED}❌ Error: .gitignore not properly configured${NC}"
    echo "Please update .gitignore to include: imp/"
    exit 1
fi

# Check git status
echo -e "${YELLOW}📋 Checking git status...${NC}"
git status

echo ""
echo -e "${YELLOW}⚠️  Verifying no secrets will be pushed...${NC}"

# Check for dangerous patterns
DANGEROUS_FILES=$(git diff --cached --name-only 2>/dev/null | grep -E "(\.env|_api_key|_token|_password|imp/)" || true)

if [ -n "$DANGEROUS_FILES" ]; then
    echo -e "${RED}❌ DANGER: Sensitive files detected in staging area:${NC}"
    echo "$DANGEROUS_FILES"
    echo ""
    echo -e "${RED}Please remove them:${NC}"
    echo "  git reset HEAD <filename>"
    exit 1
fi

# List what will be pushed
echo ""
echo -e "${GREEN}✅ Safe files to push:${NC}"
git diff --cached --name-only | head -20
if [ $(git diff --cached --name-only | wc -l) -gt 20 ]; then
    echo "... and more"
fi

echo ""
read -p "Continue with push? (y/N) " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Push cancelled."
    exit 0
fi

echo -e "${YELLOW}📤 Pushing to origin...${NC}"
git push -u origin main

echo ""
echo -e "${GREEN}✅ Push completed successfully!${NC}"
echo ""
echo -e "${YELLOW}📝 Remember to update HF Spaces secrets:${NC}"
echo "  1. Go to Space Settings → Secrets and variables"
echo "  2. Update HF_TOKEN and other environment variables"
echo "  3. Restart the Space"
