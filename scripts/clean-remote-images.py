"""清理已具备远程来源的共享图片；默认只预览，--apply 才执行。运行前停止采集程序。"""
import argparse, sqlite3, json, pathlib, datetime, urllib.parse
p=argparse.ArgumentParser(); p.add_argument('--apply',action='store_true'); a=p.parse_args()
root=pathlib.Path.home()/'Library/Application Support/Obsidian WeChat Reader'
db=sqlite3.connect(root/'data/collector.sqlite')
rows=[(i,json.loads(data)) for i,data in db.execute('select id,data from articles')]
def valid(value):
    try:
        u=urllib.parse.urlsplit(value or ''); h=u.hostname or ''
        return u.scheme=='https' and not u.username and not u.password and not u.port and any(h==d or h.endswith('.'+d) for d in ['qpic.cn','qlogo.cn'])
    except ValueError:return False
files=[]
for i,row in rows:
    allowed={asset['id'] for asset in row.get('assets',[]) if valid(asset.get('sourceUrl'))}
    folder=root/'data/articles'/i
    if folder.is_symlink() or folder.parent != root/'data/articles': continue
    for f in folder.glob('*/*.img'):
        if f.stem in allowed and not f.is_symlink() and not f.parent.is_symlink(): files.append((f,f.stat().st_size))
print(json.dumps({'files':len(files),'bytes':sum(size for _,size in files),'apply':a.apply}))
if a.apply:
    stamp=datetime.datetime.now().strftime('%Y%m%d-%H%M%S')
    backup=root/'data'/('before-remote-images-'+stamp+'.sqlite')
    with sqlite3.connect(backup) as target:db.backup(target)
    report=root/'data'/('remote-images-cleanup-'+stamp+'.json')
    report.write_text(json.dumps({'backup':str(backup),'files':[{'path':str(f.relative_to(root)),'bytes':s} for f,s in files]},ensure_ascii=False,indent=2))
    for i,row in rows:
        for asset in row.get('assets',[]):
            if valid(asset.get('sourceUrl')):asset['state']='remote'
        db.execute('update articles set data=? where id=?',(json.dumps(row,ensure_ascii=False),i))
    db.commit()
    snapshot=root/'runtime/schedule.json'
    if snapshot.exists():
        data=json.loads(snapshot.read_text()); lookup=dict(rows)
        for row in data.get('articles',[]):
            if row['id'] in lookup:row['assets']=[{k:v for k,v in asset.items() if k!='file'} for asset in lookup[row['id']].get('assets',[])]
        tmp=snapshot.with_suffix('.tmp');tmp.write_text(json.dumps(data,ensure_ascii=False));tmp.replace(snapshot)
    for f,_ in files:f.unlink()
    print('report:',report)
