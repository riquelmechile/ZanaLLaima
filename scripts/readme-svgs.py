# Genera la mascota, los botones de idioma y los diagramas ES/EN del README.
# Uso: python3 scripts/readme-svgs.py  (SVG puro: viewBox, title/desc, sin imágenes ni scripts)
import os,html
OUT=os.path.join(os.path.dirname(os.path.abspath(__file__)),'..','assets')
FONT="system-ui,-apple-system,'Segoe UI',Helvetica,Arial,sans-serif"
INK='#1F2933'; MUTED='#52606D'; OR='#F28C28'; OR2='#D9661A'; ORT='#FFF4E6'; GR='#3FA34D'; GR2='#2E7D32'; BL='#2563EB'; BLT='#EEF4FF'; GRT='#EEF8F0'
def esc(s): return html.escape(s,quote=True)
def write(path,s):
    with open(os.path.join(OUT,path),'w') as f: f.write(s)

# ---------- Mascota ----------
def carrot(prefix,scale=1.0,tx=0,ty=0,full=True):
    g=f'<g transform="translate({tx} {ty}) scale({scale})">'
    g+=f'''
  <ellipse cx="120" cy="292" rx="62" ry="9" fill="{INK}" opacity=".12"/>
  <path d="M120 74 C104 44 82 36 66 42 C82 50 98 62 112 78 Z" fill="{GR}"/>
  <path d="M120 72 C118 40 126 18 138 8 C140 30 134 54 126 76 Z" fill="{GR2}"/>
  <path d="M122 76 C140 50 162 44 178 50 C162 58 146 68 130 82 Z" fill="{GR}"/>
  <path d="M72 84 Q120 62 168 84 Q178 100 166 124 L129 280 Q120 294 111 280 L74 124 Q62 100 72 84 Z" fill="url(#{prefix}body)"/>
  <path d="M84 150 q12 6 24 2 M134 172 q12 4 22 -2 M96 214 q10 5 20 1 M128 240 q7 3 13 -1 M90 104 q8 4 16 2" fill="none" stroke="{OR2}" stroke-width="3" stroke-linecap="round" opacity=".55"/>
  <path d="M84 108 q11 -9 24 -3" fill="none" stroke="{INK}" stroke-width="4" stroke-linecap="round"/>
  <path d="M132 105 q13 -6 24 3" fill="none" stroke="{INK}" stroke-width="4" stroke-linecap="round"/>
  <circle cx="97" cy="130" r="21" fill="#E8F3FF" opacity=".85"/>
  <circle cx="143" cy="130" r="21" fill="#E8F3FF" opacity=".85"/>
  <circle cx="99" cy="132" r="6.5" fill="{INK}"/><circle cx="141" cy="132" r="6.5" fill="{INK}"/>
  <circle cx="101.5" cy="129.5" r="2.2" fill="#fff"/><circle cx="143.5" cy="129.5" r="2.2" fill="#fff"/>
  <circle cx="97" cy="130" r="21" fill="none" stroke="{INK}" stroke-width="5.5"/>
  <circle cx="143" cy="130" r="21" fill="none" stroke="{INK}" stroke-width="5.5"/>
  <path d="M118 128 q2 -4 4 0" fill="none" stroke="{INK}" stroke-width="5" stroke-linecap="round"/>
  <path d="M76 126 L66 122 M164 126 L174 122" stroke="{INK}" stroke-width="5" stroke-linecap="round"/>
  <path d="M84 116 q4 -2 8 0" stroke="#fff" stroke-width="2.5" stroke-linecap="round" opacity=".9" fill="none"/>
  <path d="M106 166 q14 12 28 0" fill="none" stroke="{INK}" stroke-width="4.5" stroke-linecap="round"/>
  <rect x="115" y="167" width="10" height="7" rx="1.5" fill="#fff" stroke="{INK}" stroke-width="2"/>
  <circle cx="86" cy="158" r="6" fill="#F7A072" opacity=".55"/><circle cx="154" cy="158" r="6" fill="#F7A072" opacity=".55"/>
  <path d="M120 190 L102 180 L102 200 Z M120 190 L138 180 L138 200 Z" fill="{BL}"/>
  <circle cx="120" cy="190" r="4.5" fill="#1D4ED8"/>'''
    if full:
        g+=f'''
  <path d="M86 206 Q62 214 50 230" fill="none" stroke="{OR2}" stroke-width="6" stroke-linecap="round"/>
  <g transform="rotate(-8 44 252)">
    <rect x="14" y="222" width="62" height="78" rx="6" fill="#fff" stroke="{INK}" stroke-width="3.5"/>
    <rect x="34" y="216" width="22" height="10" rx="3" fill="{INK}"/>
    <g font-family="{FONT}" font-size="10" font-weight="700" fill="{INK}">
      <text x="22" y="244">R1</text><text x="22" y="260">R2</text><text x="22" y="276">R3</text><text x="22" y="292">R4</text>
    </g>
    <path d="M44 240 l4 4 8 -9 M44 256 l4 4 8 -9 M44 272 l4 4 8 -9 M44 288 l4 4 8 -9" fill="none" stroke="{GR2}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
  </g>
  <path d="M156 200 Q182 186 190 160" fill="none" stroke="{OR2}" stroke-width="6" stroke-linecap="round"/>
  <path d="M186 160 q2 -14 6 -18 q3 6 -1 18 Z" fill="{OR2}"/>
  <circle cx="190" cy="132" r="5" fill="#FDE68A" stroke="{INK}" stroke-width="2"/>
  <path d="M190 118 v-6 M178 122 l-4 -4 M202 122 l4 -4" stroke="#F59E0B" stroke-width="3" stroke-linecap="round"/>'''
    g+='</g>'
    return g
def defs(prefix):
    return f'''<defs>
  <linearGradient id="{prefix}body" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#F9A24A"/><stop offset="1" stop-color="{OR2}"/>
  </linearGradient>
</defs>'''
mascot=f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 310" role="img" aria-labelledby="zl-m-t zl-m-d">
<title id="zl-m-t">ZanaLLaima</title>
<desc id="zl-m-d">Zanahoria nerd con lentes redondos, corbata de humita azul y una tabla con las cuatro revisiones R1 a R4 marcadas. / A nerdy carrot with round glasses, a blue bow tie and a clipboard with the four reviews R1 to R4 checked.</desc>
{defs('zlm-')}
{carrot('zlm-')}
</svg>
'''
write('brand/zanallaima.svg',mascot)

# ---------- Botones de idioma ----------
def button(code,label,active,fname):
    w=150;h=40
    fill=OR if active else '#FFFFFF'; stroke=OR2 if active else '#CBD2D9'; tc='#FFFFFF' if active else INK; cc=OR2 if not active else '#FFFFFF'
    desc={('ES',True):'Idioma actual: Español',('ES',False):'Ver este README en español',('EN',True):'Current language: English',('EN',False):'View this README in English'}[(code,active)]
    s=f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w}" height="{h}" role="img" aria-labelledby="b-{fname}-t b-{fname}-d">
<title id="b-{fname}-t">{esc(label)}</title>
<desc id="b-{fname}-d">{desc}</desc>
<rect x="1" y="1" width="{w-2}" height="{h-2}" rx="19" fill="{fill}" stroke="{stroke}" stroke-width="2"/>
<rect x="10" y="9" width="34" height="22" rx="11" fill="{'#FFFFFF' if active else ORT}" opacity="{'.25' if active else '1'}"/>
<text x="27" y="25" text-anchor="middle" font-family="{FONT}" font-size="13" font-weight="800" fill="{cc}">{code}</text>
<text x="56" y="26" font-family="{FONT}" font-size="16" font-weight="{700 if active else 600}" fill="{tc}">{esc(label)}</text>
</svg>
'''
    write('brand/'+fname+'.svg',s)
button('ES','Español',True,'lang-es-active'); button('ES','Español',False,'lang-es')
button('EN','English',True,'lang-en-active'); button('EN','English',False,'lang-en')

# ---------- Helpers de diagrama ----------
def text(x,y,s,size=15,weight=400,fill=INK,anchor='start'):
    return f'<text x="{x}" y="{y}" font-family="{FONT}" font-size="{size}" font-weight="{weight}" fill="{fill}" text-anchor="{anchor}">{esc(s)}</text>'
def box(x,y,w,h,fill,stroke,rx=14):
    return f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{rx}" fill="{fill}" stroke="{stroke}" stroke-width="2"/>'
def arrow(d,color=INK,dash=False,mid='a'):
    da='stroke-dasharray="7 6"' if dash else ''
    return f'<path d="{d}" fill="none" stroke="{color}" stroke-width="2.5" {da} marker-end="url(#{mid})"/>'
def marker(mid,color):
    return f'<marker id="{mid}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 Z" fill="{color}"/></marker>'

# ---------- Arquitectura ----------
ARCH={
'es':dict(title='Arquitectura de ZanaLLaima',desc='La app de ChatGPT se conecta por MCP con OAuth a ZanaLLaima en tu propio servidor. ZanaLLaima usa el MCP oficial de GitHub para escribir solo en la rama de la misión, GitHub Actions corre los tests y la cuenta revisora firma la review; el merge exige el SHA exacto.',
  app='App de ChatGPT',app_items=['Conversación autora','Conversación revisora','(nueva, solo lectura)','Los 4 lentes R1–R4'],
  link1='MCP + OAuth',link2=['HTTPS','túnel Cloudflare'],
  zl='ZanaLLaima',zl_sub='MCP remoto en tu servidor',zl_items=['Misiones, unidades y presupuesto','Skills: zana-odd y zana-4r','Tickets de revisión por SHA','Política: solo rama zana/<misión>','zana_merge con SHA exacto'],
  ghmcp='GitHub MCP oficial',ghmcp_sub=['Lee el repo y escribe','solo en la rama de la misión'],
  gh='GitHub',gh_sub=['PR + review firmada por','la cuenta revisora y zana/4r'],
  act='GitHub Actions',act_sub=['Corre los tests (checks)'],
  l_allow='allowlist',l_review='review · merge',l_push='push',l_checks=['resultado','de checks'],
  foot='Los tokens viven solo en el servidor. La verdad es el SHA en GitHub y sus checks.'),
'en':dict(title='ZanaLLaima architecture',desc='The ChatGPT app connects over MCP with OAuth to ZanaLLaima on your own server. ZanaLLaima uses the official GitHub MCP to write only to the mission branch, GitHub Actions runs the tests and the reviewer account signs the review; merging requires the exact SHA.',
  app='ChatGPT app',app_items=['Author conversation','Reviewer conversation','(new, read-only)','The 4 lenses R1–R4'],
  link1='MCP + OAuth',link2=['HTTPS','Cloudflare tunnel'],
  zl='ZanaLLaima',zl_sub='Remote MCP on your server',zl_items=['Missions, units and budget','Skills: zana-odd and zana-4r','Review tickets bound to a SHA','Policy: only branch zana/<mission>','zana_merge with the exact SHA'],
  ghmcp='Official GitHub MCP',ghmcp_sub=['Reads the repo, writes','only to the mission branch'],
  gh='GitHub',gh_sub=['PR + review signed by the','reviewer account and zana/4r'],
  act='GitHub Actions',act_sub=['Runs the tests (checks)'],
  l_allow='allowlist',l_review='review · merge',l_push='push',l_checks=['check','results'],
  foot='Tokens live only on the server. The truth is the SHA on GitHub and its checks.'),
}
for lang,t in ARCH.items():
    p='zla'+lang+'-'
    s=f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1040 460" role="img" aria-labelledby="{p}t {p}d">
<title id="{p}t">{esc(t['title'])}</title>
<desc id="{p}d">{esc(t['desc'])}</desc>
<defs>{marker(p+'a',INK)}{marker(p+'o',OR2)}
<linearGradient id="{p}body" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#F9A24A"/><stop offset="1" stop-color="{OR2}"/></linearGradient></defs>
<rect x="1" y="1" width="1038" height="458" rx="20" fill="#FFFFFF" stroke="#E4E7EB" stroke-width="2"/>
'''
    # App
    s+=box(30,110,230,230,BLT,'#93B4F5')+text(145,148,t['app'],19,800,anchor='middle')
    yy=184
    for it in t['app_items']:
        sub=it.startswith('(')
        s+=text(145,yy,it,14 if sub else 15,400 if sub else 600,MUTED if sub else INK,'middle'); yy+=26 if not sub else 30
    # link A->B
    s+=arrow('M262 225 H372',INK,mid=p+'a')+text(318,212,t['link1'],13,700,anchor='middle')+text(318,246,t['link2'][0],12,400,MUTED,'middle')+text(318,262,t['link2'][1],12,400,MUTED,'middle')
    # ZanaLLaima box
    s+=box(380,60,300,330,ORT,OR)+f'<rect x="380" y="60" width="300" height="70" rx="14" fill="{OR}"/>'+f'<rect x="380" y="110" width="300" height="20" fill="{OR}"/>'
    s+=text(400,93,t['zl'],22,800,'#FFFFFF')+text(400,117,t['zl_sub'],13,600,'#FFF4E6')
    s+=carrot(p,0.2,630,62,full=False)
    yy=166
    for it in t['zl_items']:
        s+=f'<circle cx="402" cy="{yy-5}" r="4" fill="{OR2}"/>'+text(414,yy,it,14.5,600); yy+=44
    # Right boxes
    s+=box(780,40,230,110,'#F5F7FA','#9AA5B1')+text(895,74,t['ghmcp'],17,800,anchor='middle')+text(895,100,t['ghmcp_sub'][0],13.5,400,MUTED,'middle')+text(895,120,t['ghmcp_sub'][1],13.5,400,MUTED,'middle')
    s+=box(780,180,230,110,GRT,'#7BC08A')+text(895,214,t['gh'],17,800,anchor='middle')+text(895,240,t['gh_sub'][0],13.5,400,MUTED,'middle')+text(895,260,t['gh_sub'][1],13.5,400,MUTED,'middle')
    s+=box(780,320,230,80,GRT,'#7BC08A')+text(895,352,t['act'],17,800,anchor='middle')+text(895,376,t['act_sub'][0],13.5,400,MUTED,'middle')
    # arrows
    s+=arrow('M682 105 H772',INK,mid=p+'a')+text(727,96,t['l_allow'],12,700,anchor='middle')
    s+=arrow('M682 235 H772',INK,mid=p+'a')+text(727,226,t['l_review'],11.5,700,anchor='middle')
    s+=arrow('M895 152 V172',INK,mid=p+'a')+text(905,167,t['l_push'],12,700)
    s+=arrow('M895 292 V312',INK,mid=p+'a')
    s+=arrow('M778 362 H688',OR2,True,mid=p+'o')+text(733,338,t['l_checks'][0],12,700,OR2,'middle')+text(733,352,t['l_checks'][1],12,700,OR2,'middle')
    s+=text(520,435,t['foot'],14,600,MUTED,'middle')
    s+='</svg>\n'
    write(f'diagrams/arquitectura.{lang}.svg',s)

# ---------- Flujo ----------
FLOW={
'es':dict(title='Flujo de trabajo de ZanaLLaima',desc='Tres carriles: la conversación autora crea la misión, escribe en la rama y abre el PR, espera checks verdes, completa la unidad y pide un ticket; una conversación revisora nueva reclama el ticket, lee el diff completo, corre los cuatro lentes y finaliza; GitHub recibe la review firmada por la cuenta revisora, y zana_merge mergea con el SHA exacto. Si se piden cambios, zana_correction_start vuelve al carril autor.',
  lanes=['Conversación','autora','Conversación','revisora (nueva)','GitHub'],
  s=[('1 Misión','zana_mission_init'),('2 Commits + PR','en zana/<misión>'),('3 Checks verdes','en GitHub Actions'),('4 Completa','la unidad'),('5 Pide ticket','ZR-…'),
     ('6 Reclama','el ticket'),('7 Lee el diff','completo'),('8 Cuatro lentes','R1 · R2 · R3 · R4'),('9 Finaliza','mismo SHA'),
     ('10 Review firmada','cuenta revisora'),('11 Merge','SHA exacto'),('12 Cierra','y archiva')],
  loop1='Si piden cambios:',loop2='zana_correction_start',paste='el usuario pega el ticket'),
'en':dict(title='ZanaLLaima workflow',desc='Three lanes: the author conversation creates the mission, writes to the branch and opens the PR, waits for green checks, completes the unit and requests a ticket; a new reviewer conversation claims the ticket, reads the full diff, runs the four lenses and finalizes; GitHub receives the review signed by the reviewer account, and zana_merge merges with the exact SHA. If changes are requested, zana_correction_start goes back to the author lane.',
  lanes=['Author','conversation','Reviewer','conversation (new)','GitHub'],
  s=[('1 Mission','zana_mission_init'),('2 Commits + PR','on zana/<mission>'),('3 Green checks','in GitHub Actions'),('4 Complete','the unit'),('5 Request','ticket ZR-…'),
     ('6 Claim','the ticket'),('7 Read the','full diff'),('8 Four lenses','R1 · R2 · R3 · R4'),('9 Finalize','same SHA'),
     ('10 Signed review','reviewer account'),('11 Merge','exact SHA'),('12 Close','and archive')],
  loop1='Changes requested:',loop2='zana_correction_start',paste='the user pastes the ticket'),
}
XS=[180,352,524,696,868]; W=150; H=70
LANES=[(40,BLT.replace('EEF4FF','FFF4E6'),'#F6C38E'),(180,BLT,'#A9C2F5'),(320,GRT,'#A8D5B1')]
for lang,t in FLOW.items():
    p='zlf'+lang+'-'
    s=f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1040 470" role="img" aria-labelledby="{p}t {p}d">
<title id="{p}t">{esc(t['title'])}</title>
<desc id="{p}d">{esc(t['desc'])}</desc>
<defs>{marker(p+'a',INK)}{marker(p+'o',OR2)}</defs>
<rect x="1" y="1" width="1038" height="468" rx="20" fill="#FFFFFF" stroke="#E4E7EB" stroke-width="2"/>
'''
    fills=[ORT,BLT,GRT]; strokes=['#F6C38E','#A9C2F5','#A8D5B1']
    for i,(y,_,_) in enumerate(LANES):
        s+=f'<rect x="20" y="{y}" width="1000" height="120" rx="14" fill="{fills[i]}" stroke="{strokes[i]}" stroke-width="1.5"/>'
    L=t['lanes']
    s+=text(90,92,L[0],15,800,anchor='middle')+text(90,112,L[1],15,800,anchor='middle')
    s+=text(90,232,L[2],15,800,anchor='middle')+text(90,252,L[3],13,700,MUTED,'middle')
    s+=text(90,385,L[4],15,800,anchor='middle')
    def step(x,y,a,b,hl=False):
        out=box(x,y,W,H,'#FFFFFF',OR2 if hl else '#9AA5B1',12)
        out+=text(x+W/2,y+30,a,15,800,anchor='middle')+text(x+W/2,y+52,b,13,500,MUTED,'middle')
        return out
    st=t['s']
    y1,y2,y3=65,205,345
    for i in range(5): s+=step(XS[i],y1,*st[i],hl=(i==4))
    for i in range(4): s+=arrow(f'M{XS[i]+W+2} {y1+35} H{XS[i+1]-4}',INK,mid=p+'a')
    # lane 2, right to left: 6 at XS[4], 7 at XS[3], 8 at XS[2], 9 at XS[1]
    l2=[4,3,2,1]
    for k,i in enumerate(l2): s+=step(XS[i],y2,*st[5+k],hl=(k==2))
    s+=arrow(f'M{XS[4]+W/2} {y1+H+2} V{y2-4}',INK,mid=p+'a')+text(XS[4]+W/2-10,y2-30,t['paste'],12,700,BL,'end')
    for k in range(3): a=XS[l2[k]]; b=XS[l2[k+1]]; s+=arrow(f'M{a-2} {y2+35} H{b+W+4}',INK,mid=p+'a')
    # lane 3: 10 at XS[1], 11 at XS[2], 12 at XS[3]
    for k,i in enumerate([1,2,3]): s+=step(XS[i],y3,*st[9+k],hl=(k==1))
    s+=arrow(f'M{XS[1]+W/2} {y2+H+2} V{y3-4}',INK,mid=p+'a')
    s+=arrow(f'M{XS[1]+W+2} {y3+35} H{XS[2]-4}',INK,mid=p+'a')+arrow(f'M{XS[2]+W+2} {y3+35} H{XS[3]-4}',INK,mid=p+'a')
    # loop
    s+=arrow(f'M{XS[1]-2} {y3+35} H164 V150 H{XS[1]+W/2} V{y1+H+4}',OR2,True,mid=p+'o')
    s+=text(176,y3+62,t['loop1'],12.5,700,OR2)+text(176,y3+80,t['loop2'],12.5,700,OR2)
    s+='</svg>\n'
    write(f'diagrams/flujo.{lang}.svg',s)
print('ok')
