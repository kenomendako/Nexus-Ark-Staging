import os
import subprocess
import sys
import shutil

def run_command(cmd, cwd=None):
    print(f"Executing: {cmd}")
    result = subprocess.run(cmd, shell=True, cwd=cwd, text=True)
    if result.returncode != 0:
        print(f"Error: Command failed with exit code {result.returncode}")
        sys.exit(1)

def deploy():
    # 1. パス確認
    project_root = os.getcwd()
    dist_dir = os.path.join(project_root, "dist")
    
    if not os.path.exists(dist_dir):
        print("Error: dist directory not found. Please run build_release.py first.")
        sys.exit(1)

    # 2. 安全確認: 重要な開発用ファイルが混じっていないか
    illegal_files = [".agent", "docs/reports", ".git"] # app/ ではない直下の .git
    for f in illegal_files:
        if os.path.exists(os.path.join(dist_dir, f)):
            print(f"Error: Safety check failed! Found illegal development file in dist: {f}")
            sys.exit(1)

    # 3. リモート設定の取得
    remote_url = "https://github.com/kenomendako/Nexus-Ark-Staging.git"
    
    print(f"🚀 Deploying contents of {dist_dir} to {remote_url}")
    
    # 4. Git操作 (一時的なGit初期化)
    # 既存の .git があっても一度消してクリーンにする
    git_dir = os.path.join(dist_dir, ".git")
    if os.path.exists(git_dir):
        shutil.rmtree(git_dir)

    run_command("git init", cwd=dist_dir)
    run_command("git checkout -b main", cwd=dist_dir)
    run_command("git config user.email 'kenomendako@example.com'", cwd=dist_dir)
    run_command("git config user.name 'Kenomendako'", cwd=dist_dir)
    run_command("git add .", cwd=dist_dir)
    run_command("git commit -m 'Release update via auto-deploy script'", cwd=dist_dir)
    run_command(f"git remote add origin {remote_url}", cwd=dist_dir)
    
    # 5. プッシュ (確認後に実行)
    print("\n⚠️  READY TO FORCE PUSH TO PUBLIC REPOSITORY.")
    confirm = input("Are you sure? (y/N): ")
    if confirm.lower() == 'y':
        run_command("git push -f origin main", cwd=dist_dir)
        print("\n✨ Deployment successful!")
    else:
        print("\n🛑 Deployment cancelled by user.")

if __name__ == "__main__":
    deploy()
