"""Hostrix recovery archive, with controlled dependency installation; no secrets."""
from pathlib import Path
from zipfile import ZipFile,ZIP_DEFLATED
import hashlib,json,subprocess,sys,tempfile
root=Path(__file__).resolve().parent.parent
output=Path(sys.argv[1])
with tempfile.TemporaryDirectory() as temporary:
    source=Path(temporary)/'source.zip'
    subprocess.run([sys.executable,str(root/'tools/build-botkeep.py'),str(source)],check=True,stdout=subprocess.DEVNULL)
    with ZipFile(source) as original,ZipFile(output,'w',ZIP_DEFLATED) as archive:
        for info in original.infolist():
            content=original.read(info.filename)
            if info.filename=='config.json':
                config=json.loads(content);config['fps']=4
                content=(json.dumps(config,indent=2)+'\n').encode()
            archive.writestr(info.filename,content)
        archive.writestr('hostrix_bootstrap.py',(root/'collector/hostrix/hostrix_bootstrap.py').read_bytes())
        archive.writestr('hostrix-requirements.lock',(root/'collector/hostrix/requirements.lock').read_bytes())
        archive.writestr('HOSTRIX_SETUP.txt',(root/'collector/hostrix/HOSTRIX_SETUP.txt').read_bytes())
print(json.dumps({'archive':str(output),'bytes':output.stat().st_size,'sha256':hashlib.sha256(output.read_bytes()).hexdigest()}))
