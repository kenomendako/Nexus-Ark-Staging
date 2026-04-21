import os
import shutil
import subprocess
import sys
import glob

# 設定
DIST_DIR = "dist"
PUBLIC_REPO_URL = "https://github.com/kenomendako/Nexus-Ark-Staging.git"
BRANCH_NAME = "main"

def run_command(command, cwd=None):
    """コマンドを実行し、エラーがあれば停止する"""
    print(f"Running: {command}")
    try:
        subprocess.check_call(command, shell=True, cwd=cwd)
    except subprocess.CalledProcessError as e:
        print(f"Error executing command: {command}")
        sys.exit(1)

def verify_safety():
    """デプロイ前の安全性を最終チェックする"""
    print("🔍 Performing safety checks...")
    
    # 1. ルートディレクトリに .py ファイルが含まれていないかチェック
    # (配布版は app/ 配下にソースを格納する2層構造のため、ルートに .py があるのは異常)
    py_files = glob.glob(os.path.join(DIST_DIR, "*.py"))
    if py_files:
        print(f"❌ ERROR: Sensitive source files found in root: {py_files}")
        print("This indicates a packaging error. Deployment aborted.")
        return False

    # 2. .github フォルダ (FUNDING.yml 等) の存在チェック
    # (今回のような消失事故を防ぐため、存在しない場合は警告して停止)
    funding_file = os.path.join(DIST_DIR, ".github", "FUNDING.yml")
    if not os.path.exists(funding_file):
        print(f"❌ ERROR: FUNDING.yml not found in {DIST_DIR}/.github.")
        print("Sponsor button must be preserved. Deployment aborted.")
        return False
    
    # 3. .env や private/ などの機密データが紛れ込んでいないかチェック
    forbidden = [".env", "private", "updates", "repository", "backups", ".git"] # .git は dist 直下のもの以外
    for item in forbidden:
        path = os.path.join(DIST_DIR, "app", item)
        if os.path.exists(path):
            print(f"❌ ERROR: Sensitive item '{item}' found in app/ directory.")
            print("Security risk detected. Deployment aborted.")
            return False

    # 4. 二重ロック環境変数の確認
    if os.environ.get("ALLOW_PUBLIC_PUSH") != "true":
        print("❌ ERROR: Safety lock active.")
        print("To push to public repository, use: ALLOW_PUBLIC_PUSH=true python tools/deploy_to_public_repo.py")
        return False

    print("✅ Safety checks passed.")
    return True

def main():
    # 1. dist ディレクトリの確認
    if not os.path.exists(DIST_DIR):
        print(f"Error: {DIST_DIR} directory not found. Please run build_release.py first.")
        sys.exit(1)

    print("🚀 Starting deployment to public repository...")
    
    # 2. 安全性チェック
    if not verify_safety():
        sys.exit(1)

    # 3. Git 操作の準備
    # 注意: ここでは既存の .git を利用せず、常にクリーンな状態で同期を試みるが、
    # .github 自体はあらかじめ構築されている必要がある。
    if not os.path.exists(os.path.join(DIST_DIR, ".git")):
        print(f"Initializing Git in {DIST_DIR}...")
        run_command("git init", cwd=DIST_DIR)
        run_command(f"git remote add origin {PUBLIC_REPO_URL}", cwd=DIST_DIR)
    
    # 4. プッシュ処理
    print("Committing and Pushing...")
    run_command("git checkout -B " + BRANCH_NAME, cwd=DIST_DIR)
    run_command("git add .", cwd=DIST_DIR)
    
    # Git Identity
    run_command("git config user.email 'nexus-ark-bot@example.com'", cwd=DIST_DIR)
    run_command("git config user.name 'Nexus Ark Bot'", cwd=DIST_DIR)

    commit_message = f"Release build deployed at {os.popen('date').read().strip()}"
    try:
        run_command(f'git commit -m "{commit_message}"', cwd=DIST_DIR)
    except:
        print("No changes to commit.")

    # ここでのプッシュは、履歴が一致していることを前提とするか、
    # あるいは意図的な Force Push である必要がある。
    # スクリプトレベルでの -f は、ALLOW_PUBLIC_PUSH が true の時のみ許可される。
    run_command(f"git push -f origin {BRANCH_NAME}", cwd=DIST_DIR)

    print("\n✅ Deployment complete! Public repository updated safely.")

if __name__ == "__main__":
    main()
