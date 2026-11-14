"""Install pinned server dependencies in the project's own directory, then run.

Disable Hostrix's automatic package installer; this script owns installation.
No source, recordings, models, secrets or global packages are deleted.
"""
import argparse
from importlib import metadata
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile

ROOT=Path(__file__).resolve().parent
TARGET=ROOT/'.rw-packages'
TEMP=ROOT/'.rw-install-tmp'

def report(stage,**data):print(json.dumps({'stage':stage,**data}),flush=True)
def normalize(name):return re.sub(r'[-_.]+','-',name).lower()
def installed():
    return {normalize(d.metadata['Name']):d.version for d in metadata.distributions(path=[str(TARGET)])}
def entries():
    lines=(ROOT/'hostrix-requirements.lock').read_text().splitlines()
    for line in lines:
        if not re.fullmatch(r'[a-zA-Z0-9-]+==[0-9][a-zA-Z0-9.]*',line):raise ValueError('Invalid dependency lock')
        name,version=line.split('==')
        if normalize(name) in {'opencv-python','opencv-contrib-python','opencv-contrib-python-headless'}:raise ValueError('Only one headless OpenCV distribution is allowed')
        yield name,version

def repair_cache():
    # pip's cache belongs to the current runtime account. Check its reported
    # location before purging; never recursively delete /tmp or site-packages.
    result=subprocess.run([sys.executable,'-m','pip','cache','dir'],capture_output=True,text=True)
    if result.returncode:report('cache_purge_skipped',reason='cache_directory_unavailable');return
    cache=Path(result.stdout.strip()).resolve()
    home=Path.home().resolve()
    if not cache.is_relative_to(ROOT) and not (home!=Path('/') and cache.is_relative_to(home)):
        report('cache_purge_skipped',reason='outside_runtime_home');return
    subprocess.run([sys.executable,'-m','pip','cache','purge'],check=True,timeout=60)
    report('pip_cache_purged')

def install():
    TARGET.mkdir(exist_ok=True);TEMP.mkdir(exist_ok=True)
    env={**os.environ,'PIP_NO_CACHE_DIR':'1','PIP_DISABLE_PIP_VERSION_CHECK':'1','PYTHONDONTWRITEBYTECODE':'1','TMPDIR':str(TEMP)}
    for name,version in entries():
        if installed().get(normalize(name))==version:continue
        report('installing_package',package=name,version=version)
        # One wheel at a time, no source builds, dependency resolver, persistent
        # HTTP cache or .pyc duplication. The lock includes the full dependency set.
        with tempfile.TemporaryDirectory(dir=TEMP,prefix='wheel-') as scratch:
            stage_env={**env,'TMPDIR':scratch}
            subprocess.run([sys.executable,'-m','pip','install','--index-url','https://pypi.org/simple','--no-cache-dir','--no-compile','--only-binary=:all:','--no-deps','--upgrade','--target',str(TARGET),'--timeout','30','--retries','2',name+'=='+version],env=stage_env,check=True,timeout=600)
    env.update(PYTHONPATH=str(TARGET),PYTHONNOUSERSITE='1')
    # A fresh process proves imports resolve to the private headless installation,
    # even if the hosting image has a conflicting global GUI OpenCV package.
    code="import importlib,json; from pathlib import Path; modules=[importlib.import_module(n) for n in ['cv2','numpy','requests','imageio_ffmpeg','dotenv']]; root=Path('.rw-packages').resolve(); assert all(Path(m.__file__).resolve().is_relative_to(root) for m in modules); print(json.dumps({'isolated_imports_verified':True,'opencv':modules[0].__version__}))"
    subprocess.run([sys.executable,'-c',code],cwd=ROOT,env=env,check=True,timeout=60)
    count=sum(p.stat().st_size for p in TARGET.rglob('*') if p.is_file())
    report('dependencies_ready',installed_mib=round(count/1024**2,2),project_free_mib=round(shutil.disk_usage(ROOT).free/1024**2,2))
    return env

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--repair',action='store_true');parser.add_argument('--install-only',action='store_true');args=parser.parse_args()
    os.chdir(ROOT)
    if sys.version_info[:2]!=(3,12):raise RuntimeError('Select Python 3.12 in Startup')
    report('disk_diagnostics',project_free_mib=round(shutil.disk_usage(ROOT).free/1024**2,2),system_temp_free_mib=round(shutil.disk_usage(tempfile.gettempdir()).free/1024**2,2))
    if args.repair:repair_cache()
    env=install()
    if args.install_only:return
    report('starting_preflight_or_collector',mode=os.environ.get('ROADWATCH_MODE','preflight'))
    os.execve(sys.executable,[sys.executable,'-u',str(ROOT/'main.py')],env)

if __name__=='__main__':
    try:main()
    except subprocess.CalledProcessError as e:report('setup_failed',reason='package_install_or_import_failed',returncode=e.returncode);sys.exit(1)
    except OSError as e:report('setup_failed',errno=e.errno,reason='filesystem_error');sys.exit(1)
