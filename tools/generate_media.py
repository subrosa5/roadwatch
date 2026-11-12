"""Generate original synthetic road evidence. No real footage or model inference.

Run: uv run --with pillow --with imageio-ffmpeg python tools/generate_media.py
"""
from pathlib import Path
import math
import subprocess

import imageio_ffmpeg
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
DEST = ROOT / 'web' / 'clips'
DEST.mkdir(parents=True, exist_ok=True)
W,H,FPS = 960,540,12

def frame(kind, index):
    t = index / FPS
    im = Image.new('RGB',(W,H),'#435153')
    d = ImageDraw.Draw(im)
    # Stylized oblique CCTV scene; intentionally illustrative, not photoreal footage.
    d.rectangle((0,0,W,140), fill='#394b50')
    for i in range(15):
        x=i*79-25; y=50+(i%3)*16
        d.polygon([(x,y),(x+55,y-9),(x+55,140),(x,145)],fill=['#596566','#626c68','#536063'][i%3])
        for wy in range(y+13,135,17):
            for wx in range(x+8,x+52,12):d.rectangle((wx,wy,wx+4,wy+6),fill='#a0aaa170')
    d.polygon([(0,208),(W,155),(W,440),(0,510)],fill='#79837b')
    d.polygon([(0,245),(W,184),(W,408),(0,476)],fill='#3a4242')
    for yy in [291,346,400]:
        for x in range(-100,W,100):
            shift=int(t*26)%100
            d.line([(x+shift,yy),(x+48+shift,yy-4)],fill='#9b9f91',width=3)
    d.line([(0,355),(W,286)],fill='#c4b27e',width=3)
    d.line([(0,365),(W,296)],fill='#c4b27e',width=3)
    for x in range(25,W,150):
        d.line([(x,165),(x+12,480)],fill='#263c36',width=3)
        d.ellipse((x-19,158,x+20,202),fill='#304d3d')
        d.ellipse((x-8,140,x+29,187),fill='#385a43')
    def car(x,y,color,angle=0):
        tile=Image.new('RGBA',(115,66),(0,0,0,0));p=ImageDraw.Draw(tile)
        p.rounded_rectangle((8,10,104,54),radius=8,fill=color,outline='#1c2929',width=2)
        p.polygon([(30,13),(70,13),(78,49),(35,49)],fill='#273b41')
        p.line((52,15,58,48),fill='#60777a',width=2)
        p.rectangle((9,18,14,25),fill='#e3d7a5');p.rectangle((9,40,14,47),fill='#e3d7a5')
        im.paste(tile.rotate(angle,expand=False),(round(x),round(y)),tile.rotate(angle,expand=False))
    progress=t/12
    x1=(.22+progress*.38)*W;x2=(.64-progress*.27)*W
    if kind=='collision' and t>4:
        x1=.39*W;x2=.49*W
    car(x1,.46*H,'#b4bbb7',-7 if kind!='collision' or t<4 else -22)
    car(x2,.57*H,'#6e9298',-7 if kind!='collision' or t<4 else 17)
    car((.9-progress*.45)*W,.38*H,'#c7aa75',-7)
    car((.08+progress*.5)*W,.71*H,'#89929a',-7)
    if kind in {'smoke','fire'} and t>4:
        for i in range(15):
            radius=13+(i%4)*7
            cx=.61*W+math.sin(i*1.7+t)*19
            cy=.55*H-i*8-((t*12+i*9)%30)
            layer=Image.new('RGBA',(W,H),(0,0,0,0));ld=ImageDraw.Draw(layer)
            ld.ellipse((cx-radius,cy-radius,cx+radius,cy+radius),fill=(132,143,140,95 if kind=='smoke' else 125))
            im=Image.alpha_composite(im.convert('RGBA'),layer).convert('RGB')
        if kind=='fire':
            d=ImageDraw.Draw(im)
            for i in range(7):
                x=.57*W+i*8;y=.59*H
                d.polygon([(x,y),(x+7,y-35-12*math.sin(t*8+i)),(x+15,y)],fill='#e5944f')
                d.polygon([(x+3,y),(x+9,y-18),(x+12,y)],fill='#f2cf79')
    d=ImageDraw.Draw(im)
    # Timestamp is a video-relative position, never presented as a real CCTV timestamp.
    d.rectangle((15,15,345,39),fill='#15251e')
    d.text((23,21),'ROADWATCH / SYNTHETIC SCENE / NOT LIVE',fill='#c5e1cc')
    d.text((W-95,23),f'T+{t:05.2f}s',fill='#d9e8dc')
    return im

for kind in ['collision','smoke','fire']:
    path=DEST/(kind+'.mp4')
    process=subprocess.Popen([imageio_ffmpeg.get_ffmpeg_exe(),'-hide_banner','-loglevel','error','-y','-f','rawvideo','-pix_fmt','rgb24','-s',f'{W}x{H}','-r',str(FPS),'-i','-','-an','-c:v','libx264','-preset','veryfast','-crf','27','-pix_fmt','yuv420p','-movflags','+faststart',str(path)],stdin=subprocess.PIPE)
    for i in range(12*FPS):process.stdin.write(frame(kind,i).tobytes())
    process.stdin.close()
    if process.wait():raise RuntimeError('FFmpeg failed')
    frame(kind,7*FPS).save(DEST/(kind+'.jpg'),quality=85)
    print(kind,path.stat().st_size,'bytes')
