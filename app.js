// ===== Util =====
    const MAX_STARS = 10;
    

    // ===== Supabase (Auth + Banco) =====
    // IMPORTANTE: anon key é pública. NUNCA coloque a service_role no frontend.
    const SUPABASE_URL = "https://qnraiayglvluzhuyigje.supabase.co";
    const SUPABASE_ANON_KEY = "sb_publishable_6P7JM9YccqYP2vPXNXOPdw_ogHZWqXF";
    const supaLib = window.supabase;
    const supaClient = (supaLib && typeof supaLib.createClient === 'function')
      ? supaLib.createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
      : null;
    const SUPABASE_ENABLED = !!supaClient;

    async function sha256Hex(str){
      const enc = new TextEncoder();
      const buf = await crypto.subtle.digest('SHA-256', enc.encode(str));
      const bytes = Array.from(new Uint8Array(buf));
      return bytes.map(b=>b.toString(16).padStart(2,'0')).join('');
    }

    async function supaEnsureProfileAndCpf({ userId, displayName, roleValue, cpfDigitsOnly }){
      // 1) profile
      const { error: pErr } = await supaClient
        .from('profiles')
        .upsert({ user_id: userId, display_name: displayName, role: roleValue }, { onConflict: 'user_id' });
      if(pErr) throw pErr;

      // 2) cpf (hash + last4). Sem armazenar CPF puro.
      if(cpfDigitsOnly){
        const cpfHash = await sha256Hex(String(cpfDigitsOnly));
        const last4 = String(cpfDigitsOnly).slice(-4);
        const { error: cErr } = await supaClient
          .from('user_cpf')
          .upsert({ user_id: userId, cpf_hash: cpfHash, cpf_last4: last4 }, { onConflict: 'user_id' });
        if(cErr) throw cErr;
      }
    }

    async function supaRegisterFlow({ nome, sobrenome, dob, cpfD, email, senha, roleUi }){
      if(!SUPABASE_ENABLED) throw new Error('Supabase não inicializou.');

      const displayName = `${nome} ${sobrenome}`.trim();
      const roleValue = (roleUi === 'cliente') ? 'client' : 'editor';

      const { data, error } = await supaClient.auth.signUp({
        email,
        password: senha,
        options: { data: { display_name: displayName, role: roleValue } }
      });
      if(error) throw error;

      // Se confirmação de email estiver ligada, pode não vir sessão.
      if(!data?.session || !data?.user){
        alert('Conta criada! Agora confirme o email para ativar e depois faça login.');
        return { ok:false, needsConfirm:true };
      }

      // cria profile + cpf
      await supaEnsureProfileAndCpf({
        userId: data.user.id,
        displayName,
        roleValue,
        cpfDigitsOnly: cpfD
      });

      // cria row de editor (opcional) pra aparecer na busca
      if(roleValue === 'editor'){
        const { error: eErr } = await supaClient
          .from('editors')
          .upsert({ user_id: data.user.id, headline: 'Editor', bio: '', skills: [], is_active: true }, { onConflict: 'user_id' });
        if(eErr) console.warn('Falha ao criar editor row:', eErr.message);
      }

      return { ok:true, roleValue };
    }

    async function supaLoginFlow({ email, senha }){
      if(!SUPABASE_ENABLED) throw new Error('Supabase não inicializou.');

      const { data, error } = await supaClient.auth.signInWithPassword({ email, password: senha });
      if(error) throw error;

      const userId = data?.user?.id;
      if(!userId) throw new Error('Login ok, mas não retornou user.');

      const { data: prof, error: profErr } = await supaClient
        .from('profiles')
        .select('user_id, display_name, role')
        .eq('user_id', userId)
        .maybeSingle();
      if(profErr) throw profErr;

      const { data: cpfRow } = await supaClient
        .from('user_cpf')
        .select('cpf_last4')
        .eq('user_id', userId)
        .maybeSingle();

      return { userId, profile: prof || null, cpf_last4: cpfRow?.cpf_last4 || null };
    }

    // Cria pedido no Supabase (MVP): salva como DRAFT e SEM total_cents (o total real será calculado no backend depois)
    async function supaCreateOrderFlow(order){
      if(!SUPABASE_ENABLED) throw new Error('Supabase não inicializou.');

      const { data: uData, error: uErr } = await supaClient.auth.getUser();
      if(uErr) throw uErr;
      const user = uData?.user;
      if(!user) throw new Error('Você precisa estar logado para criar pedido.');

      const packageCode = (order?.kind === 'package')
        ? `PACOTE_${order.packageId}`
        : 'CUSTOM';

      // payload guarda tudo (inclusive o total estimado do frontend), mas NÃO é usado como fonte de verdade para pagamento
      const payload = { ...order };

      const { data, error } = await supaClient
        .from('orders')
        .insert({
          client_id: user.id,
          package_code: packageCode,
          payload,
          total_cents: null,
          status: 'DRAFT'
        })
        .select('id, created_at')
        .single();

      if(error) throw error;
      return data; // {id, created_at}
    }


const START_STARS = 5.0;

    function escapeHtml(str){
      return String(str ?? "")
        .replaceAll("&","&amp;")
        .replaceAll("<","&lt;")
        .replaceAll(">","&gt;")
        .replaceAll('"',"&quot;")
        .replaceAll("'","&#039;");
    }
    function brl(v){ return Number(v||0).toLocaleString('pt-BR', {style:'currency', currency:'BRL'}); }

    function renderStarsHTML(value, max=MAX_STARS){
      const v = Math.max(0, Math.min(max, Number(value||0)));
      const full = Math.round(v);
      let html = "";
      for(let i=0;i<full;i++) html += `<span class="star">★</span>`;
      for(let i=full;i<max;i++) html += `<span class="star off">★</span>`;
      html += `<small>${v.toFixed(1)}/${max}</small>`;
      return html;
    }

    function setAvatar(el, photoDataUrl, fallbackText){
      if(!el) return;
      el.innerHTML = "";
      if(photoDataUrl){
        const img = document.createElement("img");
        img.src = photoDataUrl;
        el.appendChild(img);
      }else{
        el.textContent = (fallbackText || "K").slice(0,1).toUpperCase();
      }
    }

    function readFileAsDataURL(file){
      return new Promise((resolve, reject)=>{
        const r = new FileReader();
        r.onload = () => resolve(String(r.result||""));
        r.onerror = reject;
        r.readAsDataURL(file);
      });
    }


    // ===== Sessão (para permitir "Sair" sem apagar seus dados) =====
    const LS_SESSION = 'karameloo_session_v1';
    function getSession(){
      return lsGet(LS_SESSION, { active:null, clientEmail:'', editorEmail:'' });
    }
    function setSession(s){ lsSet(LS_SESSION, s); }
    function setActiveSession(kind){
      const s = getSession();
      if(kind==='cliente'){ s.active='cliente'; s.clientEmail = clientData?.email || s.clientEmail || ''; }
      if(kind==='editor'){ s.active='editor'; s.editorEmail = editorData?.email || s.editorEmail || ''; }
      setSession(s);
    }
    function logoutSession(){
      const s = getSession();
      s.active = null;
      setSession(s);
      try{ selectedEditorFromProcurar = null; }catch(e){}
      try{ (function(){const __ci=document.getElementById('chatInput'); if(__ci) __ci.value='';})(); }catch(e){}
    }
    function isClientLogged(){
      const s = getSession();
      return s.active==='cliente' && !!(s.clientEmail);
    }
    function isEditorLogged(){
      const s = getSession();
      return s.active==='editor' && !!(s.editorEmail);
    }

    // ===== Moderação (frontend básico + ganchos para backend) =====
    async function moderateText(text){
      const t = String(text||'').trim();
      if(!t) return { ok:true };

      // 1) tenta backend (se existir)
      try{
        if(typeof apiBase==='function' && apiBase()){
          const r = await apiFetch('/api/moderate/text', { method:'POST', body: JSON.stringify({ text:t }) });
          if(typeof r?.ok==='boolean') return r;
        }
      }catch(e){ /* fallback */ }

      // 2) fallback local (não é perfeito)
      const bad = [
        'porn','porno','putaria','p*','sexo','nude','nudes','pelado','pelada','xereca','pinto','buceta','caralho','fds','foda','foder',
        'estupr','pedofil','cp','gore','suicid',
      ];
      const low = t.toLowerCase();
      const hit = bad.find(w => low.includes(w));
      if(hit){
        return { ok:false, reason:'Mensagem bloqueada por linguagem imprópria (demo).'};
      }
      return { ok:true };
    }

    async function moderateImageDataUrl(dataUrl){
      const img = String(dataUrl||'');
      if(!img.startsWith('data:image/')) return { ok:true };

      // 1) tenta backend (se existir)
      try{
        if(typeof apiBase==='function' && apiBase()){
          const r = await apiFetch('/api/moderate/image', { method:'POST', body: JSON.stringify({ image: img }) });
          if(typeof r?.ok==='boolean') return r;
        }
      }catch(e){ /* fallback */ }

      // 2) fallback local: checagem simples (tamanho + heurística leve)
      // OBS: isso NÃO garante 100% — moderação forte precisa de backend.
      const approxBytes = Math.floor((img.split(',')[1]||'').length * 0.75);
      if(approxBytes > 2_200_000){
        return { ok:false, reason:'Imagem muito pesada. Envie uma imagem menor (até ~2MB).'};
      }
      // Heurística: se muita área com tons de pele + pouca variação, sinaliza (pode dar falso positivo).
      try{
        const im = await new Promise((res, rej)=>{
          const i = new Image();
          i.onload = ()=>res(i);
          i.onerror = rej;
          i.src = img;
        });
        const c = document.createElement('canvas');
        const w = 96;
        const h = Math.max(48, Math.round((im.height/im.width)*w));
        c.width = w;
        c.height = h;
        const ctx = c.getContext('2d', { willReadFrequently:true });
        ctx.drawImage(im, 0, 0, w, h);
        const d = ctx.getImageData(0,0,w,h).data;
        let skin=0, total=0;
        for(let p=0; p<d.length; p+=16){
          const r=d[p], g=d[p+1], b=d[p+2];
          const maxv=Math.max(r,g,b), minv=Math.min(r,g,b);
          const lum = (0.2126*r+0.7152*g+0.0722*b);
          const cond = (r>95 && g>40 && b>20 && (maxv-minv)>15 && Math.abs(r-g)>15 && r>g && r>b && lum>60);
          total++;
          if(cond) skin++;
        }
        const ratio = skin/Math.max(1,total);
        if(ratio > 0.42){
          return { ok:false, reason:'Imagem suspeita de conteúdo sensível (demo).'};
        }
      }catch(e){ /* ignora */ }

      return { ok:true };
    }

    async function checkAndReadImage(file){
      const data = await readFileAsDataURL(file);
      const m = await moderateImageDataUrl(data);
      if(!m.ok) throw new Error(m.reason || 'Imagem bloqueada');
      return data;
    }

    // ===== Capas (plano de fundo do perfil) =====
    function pkgPattern(seed){
      const n = Number(seed||1) || 1;
      const deg = (n*37)%180;
      const a = (n%3===0) ? 'rgba(255,224,138,.10)' : (n%3===1 ? 'rgba(255,193,61,.10)' : 'rgba(56,189,248,.08)');
      return `repeating-linear-gradient(${deg}deg, ${a} 0, ${a} 1px, transparent 1px, transparent 10px)`;
    }

    function presetToCover(preset){
      const p = String(preset||'none');
      if(p==='gold') return 'radial-gradient(1200px 220px at 20% 0%, rgba(255,224,138,.32), transparent 60%), radial-gradient(900px 240px at 80% 20%, rgba(255,193,61,.22), transparent 55%), linear-gradient(180deg, rgba(255,255,255,.06), rgba(255,255,255,.02))';
      if(p==='amber') return 'radial-gradient(900px 220px at 20% 0%, rgba(255,193,61,.30), transparent 60%), radial-gradient(900px 240px at 80% 20%, rgba(255,224,138,.18), transparent 55%), linear-gradient(180deg, rgba(255,255,255,.05), rgba(255,255,255,.02))';
      if(p==='sunset') return 'radial-gradient(900px 220px at 15% 0%, rgba(255,120,120,.22), transparent 60%), radial-gradient(900px 240px at 80% 20%, rgba(255,193,61,.20), transparent 55%), linear-gradient(180deg, rgba(255,255,255,.05), rgba(255,255,255,.02))';
      if(p==='graphite') return 'radial-gradient(900px 220px at 20% 0%, rgba(255,224,138,.14), transparent 60%), linear-gradient(180deg, rgba(255,255,255,.03), rgba(0,0,0,.18))';
      return '';
    }
    function applyCoverToEl(el, cover){
      if(!el) return;
      if(cover?.img){
        el.style.backgroundImage = `url(${cover.img})`;
      }else if(cover?.preset && cover.preset!=='none'){
        el.style.backgroundImage = presetToCover(cover.preset);
      }else{
        el.style.backgroundImage = '';
      }
    }

    function syncClientCoverControls(){
      const preset = document.getElementById('clCoverPreset');
      const up = document.getElementById('clCoverUpload');
      applyCoverToEl(document.getElementById('clientCover'), clientData?.cover);
      if(preset) preset.value = clientData?.cover?.preset || 'none';
      if(!clientData) return;
      // evita perder imagem se usuário trocar preset
      if(clientData.cover && !clientData.cover.preset) clientData.cover.preset = 'none';
    }

    function syncEditorCoverControls(){
      const preset = document.getElementById('edCoverPreset');
      const up = document.getElementById('edCoverUpload');
      applyCoverToEl(document.getElementById('editorCover'), editorData?.cover);
      if(preset) preset.value = editorData?.cover?.preset || 'none';
      if(!editorData) return;
      if(editorData.cover && !editorData.cover.preset) editorData.cover.preset = 'none';
    }

    async function onClientCoverPreset(){
      if(!clientData) return;
      const preset = document.getElementById('clCoverPreset');
      const v = preset ? preset.value : 'none';
      clientData.cover = { preset:v, img:'' };
      lsSet(LS_CLIENT, clientData);
      applyCoverToEl(document.getElementById('clientCover'), clientData.cover);
    }

    async function onEditorCoverPreset(){
      if(!editorData) return;
      const preset = document.getElementById('edCoverPreset');
      const v = preset ? preset.value : 'none';
      editorData.cover = { preset:v, img:'' };
      lsSet(LS_EDITOR, editorData);
      persistEditorToAccount();
      applyCoverToEl(document.getElementById('editorCover'), editorData.cover);
    }

    async function onClientCoverUpload(ev){
      const file = ev?.target?.files?.[0];
      if(!file || !clientData) return;
      try{
        const data = await checkAndReadImage(file);
        clientData.cover = { preset:'none', img:data };
        lsSet(LS_CLIENT, clientData);
        applyCoverToEl(document.getElementById('clientCover'), clientData.cover);
      }catch(err){
        alert(String(err.message||err));
        ev.target.value='';
      }
    }

    async function onEditorCoverUpload(ev){
      const file = ev?.target?.files?.[0];
      if(!file || !editorData) return;
      try{
        const data = await checkAndReadImage(file);
        editorData.cover = { preset:'none', img:data };
        lsSet(LS_EDITOR, editorData);
        persistEditorToAccount();
        applyCoverToEl(document.getElementById('editorCover'), editorData.cover);
      }catch(err){
        alert(String(err.message||err));
        ev.target.value='';
      }
    }

    function removeClientCover(){
      if(!clientData) return;
      clientData.cover = { preset:'none', img:'' };
      lsSet(LS_CLIENT, clientData);
      applyCoverToEl(document.getElementById('clientCover'), clientData.cover);
    }

    function removeEditorCover(){
      if(!editorData) return;
      editorData.cover = { preset:'none', img:'' };
      lsSet(LS_EDITOR, editorData);
      persistEditorToAccount();
      applyCoverToEl(document.getElementById('editorCover'), editorData.cover);
    }

    // ===== Menu do usuário =====
    const menuOverlay = document.getElementById('menuOverlay');
    const menuModal = document.getElementById('menuModal');
    const menuTitle = document.getElementById('menuTitle');
    const menuBody = document.getElementById('menuBody');
    let menuCtxRole = 'cliente';

    
    // ✅ Atalhos do Editor (fora do menu): Pedidos / Mensagens
    function openEditorOrders(){
      try{
        openUserMenu('editor');
        setTimeout(()=>{ if(typeof renderUserMenuOrders==='function') renderUserMenuOrders(); }, 30);
      }catch(e){}
    }
    function openEditorMessages(){
      try{
        openUserMenu('editor');
        setTimeout(()=>{ if(typeof renderUserMenuMessages==='function') renderUserMenuMessages(); }, 30);
      }catch(e){}
    }

function openUserMenu(r){
      menuCtxRole = (r==='editor') ? 'editor' : 'cliente';
      renderUserMenuHome();
      // garante que o menu fique preso na viewport (fora de containers com transform)
      try{
        if(menuOverlay && menuOverlay.parentElement !== document.body){
          document.body.appendChild(menuOverlay);
        }
      }catch(e){}
      if(menuOverlay){
        menuOverlay.classList.remove('closing');
        menuOverlay.classList.add('show');
        menuOverlay.setAttribute('aria-hidden','false');
      }
      // trava o scroll do fundo enquanto o menu estiver aberto
      document.body.style.overflow = 'hidden';
      // Re-dispara animação do modal (evita bug de só escurecer após fechar 1x)
      if(menuModal){
        menuModal.classList.remove('closing');
        menuModal.style.animation = 'none';
        // força reflow
        void menuModal.offsetHeight;
        menuModal.style.animation = '';
      }
    }
    function closeUserMenu(){
      if(!menuOverlay) return;
      menuOverlay.classList.add('closing');
      menuModal?.classList.add('closing');
      setTimeout(()=>{
        menuOverlay.classList.remove('show','closing');
        menuModal?.classList.remove('closing');
        menuOverlay.setAttribute('aria-hidden','true');
        // destrava scroll
        document.body.style.overflow = '';
      }, 220);
    }
    menuOverlay?.addEventListener('click', (e)=>{ if(e.target===menuOverlay) closeUserMenu(); });

    function menuBackBtn(label, fn){
      return `<div class="menuBack"><button class="btn secondary small" type="button" onclick="${fn}">← Voltar</button><span class="chip">${label}</span></div>`;
    }

    function setMenuHTML(htmlStr){
      if(!menuBody) return;
      menuBody.classList.remove('swap');
      void menuBody.offsetHeight;
      menuBody.classList.add('swap');
      menuBody.innerHTML = htmlStr;
    }

    function renderUserMenuHome(){
      if(!menuBody) return;
      if(menuTitle) menuTitle.textContent = 'Menu';

      const isClient = menuCtxRole==='cliente';
      const cpf = (isClient ? clientData?.cpf : editorData?.cpf) || '';
      const otherEmail = cpf ? (isClient ? findEmailByCPF('editor', cpf) : findEmailByCPF('client', cpf)) : null;
      const canSwitch = !!otherEmail;

      // Sempre mostra a opção de mudar de modo:
      // - Se já existir conta do outro tipo (mesmo CPF neste navegador), troca direto.
      // - Se não existir, abre o cadastro já no modo correto.
      const switchBtn = (()=>{
        if(isClient){
          if(canSwitch){
            return `
              <button class="menuBtn" type="button" onclick="becomeEditorFromClient()">
                <span>Entrar como Editor/Vendedor</span>
                <small>Trocar modo</small>
              </button>`;
          }
          return `
            <button class="menuBtn" type="button" onclick="becomeEditorFromClient();">
              <span>Trocar para Editor</span>
              <small>Sem relogar</small>
            </button>`;
        } else {
          if(canSwitch){
            return `
              <button class="menuBtn" type="button" onclick="switchToClientFromEditor()">
                <span>Trocar para Cliente</span>
                <small>Sem relogar</small>
              </button>`;
          }
          return `
            <button class="menuBtn" type="button" onclick="switchToClientFromEditor()">
              <span>Trocar para Cliente</span>
              <small>Sem relogar</small>
            </button>`;
        }
      })();

      setMenuHTML(`
        <div class="menuList">
          ${switchBtn}
          <button class="menuBtn" type="button" onclick="renderUserMenuSettings()">
            <span>Configurações</span><small>Conta & perfil</small>
          </button>
          <button class="menuBtn" type="button" onclick="renderUserMenuPrivacy()">
            <span>Privacidade</span><small>Dados & segurança</small>
          </button>
          <button class="menuBtn" type="button" onclick="renderUserMenuTerms()">
            <span>Termos de uso</span><small>Regras do app</small>
          </button>
          ${isClient ? `
          <button class="menuBtn menuDanger" type="button" onclick="logoutAndGoStart()">
            <span>Sair</span>
            <small>Encerrar sessão</small>
          </button>
          ` : `
          <button class="menuBtn menuDanger" type="button" onclick="logoutAndGoStart()">
            <span>Sair</span>
            <small>Encerrar sessão</small>
          </button>
          `}
          <div class="noteWarn">
            <strong>Importante:</strong> o filtro de mensagens/imagens aqui é <em>demo</em>.
            Para ficar forte de verdade, a moderação com IA deve rodar no <strong>backend</strong>.
          </div>
        </div>`);
    }

    function renderUserMenuSettings(){
      if(!menuBody) return;
      if(menuTitle) menuTitle.textContent = 'Configurações';
      const isClient = menuCtxRole==='cliente';
      setMenuHTML(`
        ${menuBackBtn('Configurações', 'renderUserMenuHome()')}
        <div class="card" style="margin:0">
          <h3 style="margin-top:0">Preferências do perfil</h3>
          <p style="opacity:.9; margin:8px 0 0">Você pode trocar a foto e a capa do seu perfil na própria tela de perfil.</p>
          <div class="pill" style="margin-top:10px">Dica: use uma capa clara para destacar seus cards no Procurar.</div>
        </div>`);
    }

    function renderUserMenuPrivacy(){
      if(!menuBody) return;
      if(menuTitle) menuTitle.textContent = 'Privacidade';
      setMenuHTML(`
        ${menuBackBtn('Privacidade', 'renderUserMenuHome()')}
        <div class="card" style="margin:0">
          <h3 style="margin-top:0">Privacidade (demo)</h3>
          <p style="opacity:.92">
            • Suas informações ficam salvas apenas no seu navegador (LocalStorage).
            <br>• Para um site real: precisa backend com banco de dados e políticas (LGPD).
            <br>• Chat e moderação fortes também entram no backend.
          </p>
        </div>`);
    }

    function renderUserMenuTerms(){
      if(!menuBody) return;
      if(menuTitle) menuTitle.textContent = 'Termos de uso';
      setMenuHTML(`
        ${menuBackBtn('Termos', 'renderUserMenuHome()')}
        <div class="card" style="margin:0">
          <h3 style="margin-top:0">Termos (resumo)</h3>
          <p style="opacity:.92">
            Ao usar o Karameloo você concorda em não enviar conteúdo ilegal, ofensivo ou impróprio.
            Perfis e mensagens podem ser filtrados e removidos.
            <br><br><strong>Etapa real:</strong> termos completos + moderação com IA no backend.
          </p>
        </div>`);
    }


    function renderUserMenuOrders(){
      if(!menuBody) return;
      if(menuTitle) menuTitle.textContent = 'Pedidos';
      const all = lsGet(LS_ORDERS, []);
      const list = Array.isArray(all) ? all : [];
      const isEditor = menuCtxRole === 'editor';
      const meName = String(editorData?.full || editorData?.first || editorData?.name || 'Editor').trim().toLowerCase();

      let use = list;
      if(isEditor && meName){
        const mine = list.filter(o => String(o?.editor?.name || '').trim().toLowerCase() === meName);
        // Se não achou pedidos “meus” (porque é demo), mostra todos mesmo
        use = mine.length ? mine : list;
      }

      const rows = use.slice(0, 30).map((o, i)=>{
        const title = escapeHtml(o?.title || 'Pedido');
        const client = escapeHtml(o?.client?.name || 'Cliente');
        const total = escapeHtml(o?.totalText || brl(o?.total || 0));
        const eta = escapeHtml(o?.eta || '—');
        const when = new Date(o?.createdAt || Date.now());
        const stamp = escapeHtml(when.toLocaleString('pt-BR'));
        const badge = o?.editor?.name ? `<span class="chip">Editor: ${escapeHtml(o.editor.name)}</span>` : `<span class="chip">Sem editor</span>`;
        return `
          <div class="card" style="margin:0 0 10px">
            <div style="display:flex; align-items:center; justify-content:space-between; gap:10px; flex-wrap:wrap">
              <div style="font-weight:900">${title}</div>
              <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center">
                ${badge}
                <span class="chip">${stamp}</span>
              </div>
            </div>
            <div class="pill" style="margin-top:10px; display:flex; gap:10px; flex-wrap:wrap">
              <span><b>Cliente:</b> ${client}</span>
              <span><b>Total:</b> ${total}</span>
              <span><b>Entrega:</b> ${eta}</span>
            </div>
          </div>`;
      }).join('');

      setMenuHTML(`
        ${menuBackBtn('Pedidos', 'renderUserMenuHome()')}
        <div class="card" style="margin:0">
          <h3 style="margin-top:0">Pedidos (demo/local)</h3>
          <p style="opacity:.9; margin:8px 0 0">
            Aqui aparecem os pedidos salvos no seu navegador. No backend (Supabase), isso vem do banco.
          </p>
        </div>
        <div style="margin-top:12px">
          ${rows || `<div class="card"><div class="hint">Nenhum pedido por enquanto.</div></div>`}
        </div>
      `);
    }

    function listChatThreads(){
      const out = [];
      try{
        for(let i=0;i<localStorage.length;i++){
          const k = localStorage.key(i);
          if(!k || !String(k).startsWith('karamelo_chat_')) continue;
          const arr = lsGet(k, []);
          const msgs = Array.isArray(arr) ? arr : [];
          const last = msgs.length ? msgs[msgs.length-1] : null;
          out.push({
            key: k,
            ts: last?.ts || 0,
            lastText: String(last?.text || '').slice(0, 80),
            lastFrom: last?.from || ''
          });
        }
      }catch(e){}
      out.sort((a,b)=>(b.ts||0)-(a.ts||0));
      return out;
    }
    function prettyChatTitleFromKey(k){
      // karamelo_chat_<clientId>_<peerId>
      const parts = String(k||'').split('_');
      const peer = parts.slice(3).join('_') || 'conversa';
      return peer.replace(/_/g,' ').slice(0, 28);
    }

    function renderUserMenuMessages(){
      if(!menuBody) return;
      if(menuTitle) menuTitle.textContent = 'Mensagens';
      const threads = listChatThreads();
      const items = threads.slice(0, 25).map(t=>{
        const title = escapeHtml(prettyChatTitleFromKey(t.key));
        const hint = escapeHtml((t.lastFrom==='me' ? 'Você: ' : '') + (t.lastText || 'Abrir conversa'));
        const enc = encodeURIComponent(t.key);
        return `
          <button class="menuBtn" type="button" onclick="renderUserMenuMessageThread('${enc}')">
            <span>${title}</span><small>${hint}</small>
          </button>`;
      }).join('');

      setMenuHTML(`
        ${menuBackBtn('Mensagens', 'renderUserMenuHome()')}
        <div class="card" style="margin:0">
          <h3 style="margin-top:0">Mensagens (demo/local)</h3>
          <p style="opacity:.9; margin:8px 0 0">
            As conversas ficam salvas no seu navegador. No backend, isso vira chat real (com moderação e histórico).
          </p>
        </div>
        <div class="menuList" style="margin-top:12px">
          ${items || `<div class="card"><div class="hint">Nenhuma conversa ainda.</div></div>`}
        </div>
      `);
    }

    function renderUserMenuMessageThread(encKey){
      const key = decodeURIComponent(String(encKey||''));
      if(menuTitle) menuTitle.textContent = 'Mensagens';
      const arr = lsGet(key, []);
      const msgs = Array.isArray(arr) ? arr : [];
      const bubbles = msgs.slice(-50).map(m=>{
        const div = document.createElement('div');
        div.className = 'aiMsg' + (m.from==='me' ? ' me' : '');
        div.textContent = String(m.text || '');
        return div.outerHTML;
      }).join('');

      setMenuHTML(`
        ${menuBackBtn('Mensagens', 'renderUserMenuMessages()')}
        <div class="card" style="margin:0">
          <h3 style="margin-top:0">${escapeHtml(prettyChatTitleFromKey(key))}</h3>
          <div class="hint">Leitura (demo). Envio completo e lista de chats entram no backend.</div>
        </div>
        <div class="card" style="margin-top:12px; padding:0">
          <div style="display:grid; gap:10px; max-height:420px; overflow:auto; padding:12px; border-radius:18px">
            ${bubbles || `<div class="hint">Sem mensagens.</div>`}
          </div>
        </div>
      `);
    }

    function logoutAndGoStart(){
      logoutSession();
      try{ closeEditorProfile(); }catch(e){}
      try{ closeChat(); }catch(e){}
      try{ closeCadastro(); }catch(e){}
      selectedEditorFromProcurar = null;
      currentOrder = null;
      closeUserMenu();
      showScreen(screenStart, true);
    }

    function becomeEditorFromClient(){
      showLoading('Trocando para Editor…','Carregando modo vendedor');
      // Troca para Editor SEM pedir email/senha novamente.
      // No modo demo/local, copiamos a conta do Cliente (se existir) para Editor automaticamente.
      try{
        // Garante que temos um perfil de cliente carregado
        const storedClient = lsGet(LS_CLIENT) || null;
        const baseClientProfile = (clientData && Object.keys(clientData||{}).length ? clientData : storedClient) || {};

        const cpf = (baseClientProfile?.cpf || '').toString();
        let email = (baseClientProfile?.email || '').toString();
        if(!email && cpf){ email = (findEmailByCPF('client', cpf) || '').toString(); }
        email = normEmail(email);

        // Recupera (ou reconstrói) a conta de Cliente
        let clientAcc = null;
        if(email){
          clientAcc = loadAccount('client', email);
        }
        if(!clientAcc){
          // fallback: cria um "account" a partir do perfil salvo (sem bloquear o usuário)
          const fallbackEmail = email || (cpf ? `cliente_${cpf}@local` : 'cliente@local');
          clientAcc = {
            email: normEmail(fallbackEmail),
            pass: '',
            cpf: cpf || '',
            profile: Object.assign({}, baseClientProfile, { email: normEmail(fallbackEmail), cpf: cpf || baseClientProfile?.cpf || '' })
          };
          // salva para manter consistência nas próximas trocas
          saveAccount('client', clientAcc);
        }

        // Se já existe conta editor com o mesmo CPF, usa ela; senão, cria.
        let editorEmail = cpf ? (findEmailByCPF('editor', cpf) || '') : '';
        editorEmail = normEmail(editorEmail || clientAcc.email);

        if(!loadAccount('editor', editorEmail)){
          const editorProfile = Object.assign({}, clientAcc.profile || {});
          editorProfile.cpf = cpf || editorProfile.cpf || '';
          editorProfile.email = editorEmail;
          editorProfile.kind = 'editor';

          saveAccount('editor', {
            email: editorEmail,
            pass: clientAcc.pass || '',
            cpf: (cpf || editorProfile.cpf || ''),
            profile: editorProfile
          });
        }

        const acc = loadAccount('editor', editorEmail);
        if(!acc){
          // última tentativa: não trava — só muda o modo visual
          role = 'editor';
          editorData = Object.assign({}, baseClientProfile, { kind:'editor' });
          lsSet(LS_EDITOR, editorData);
          setActiveSession('editor');
          closeUserMenu();
          showScreen(screenEditor);
          return;
        }

        role = 'editor';
        applyAccountToSession('editor', acc);
        setActiveSession('editor');
        closeUserMenu();
        showScreen(screenEditor);
      hideLoading();
      }catch(e){
        console.error(e);
        // Não trava a navegação por causa de localStorage inconsistente
        try{
          role = 'editor';
          setActiveSession('editor');
          closeUserMenu();
          showScreen(screenEditor);
        }catch(_){}
      }
      hideLoading();
    }

    // Compat: se algum lugar ainda chamar isso, mantém funcionando
    function switchToEditorFromClient(){
      becomeEditorFromClient();
    }
    function switchToClientFromEditor(){
      showLoading('Trocando para Cliente…','Carregando modo cliente');
      // Troca para Cliente SEM pedir email/senha novamente.
      // No modo demo/local, copiamos a conta do Editor (se existir) para Cliente automaticamente.
      try{
        const storedEditor = lsGet(LS_EDITOR) || null;
        const baseEditorProfile = (editorData && Object.keys(editorData||{}).length ? editorData : storedEditor) || {};

        const cpf = (baseEditorProfile?.cpf || '').toString();
        let email = (baseEditorProfile?.email || '').toString();
        if(!email && cpf){ email = (findEmailByCPF('editor', cpf) || '').toString(); }
        email = normEmail(email);

        // Recupera (ou reconstrói) a conta de Editor
        let editorAcc = null;
        if(email){
          editorAcc = loadAccount('editor', email);
        }
        if(!editorAcc){
          const fallbackEmail = email || (cpf ? `editor_${cpf}@local` : 'editor@local');
          editorAcc = {
            email: normEmail(fallbackEmail),
            pass: '',
            cpf: cpf || '',
            profile: Object.assign({}, baseEditorProfile, { email: normEmail(fallbackEmail), cpf: cpf || baseEditorProfile?.cpf || '' })
          };
          saveAccount('editor', editorAcc);
        }

        // Se já existe conta cliente com o mesmo CPF, usa ela; senão, cria.
        let clientEmail = cpf ? (findEmailByCPF('client', cpf) || '') : '';
        clientEmail = normEmail(clientEmail || editorAcc.email);

        if(!loadAccount('client', clientEmail)){
          const clientProfile = Object.assign({}, editorAcc.profile || {});
          clientProfile.cpf = cpf || clientProfile.cpf || '';
          clientProfile.email = clientEmail;
          clientProfile.kind = 'client';

          saveAccount('client', {
            email: clientEmail,
            pass: editorAcc.pass || '',
            cpf: (cpf || clientProfile.cpf || ''),
            profile: clientProfile
          });
        }

        const acc = loadAccount('client', clientEmail);
        if(!acc){
          // última tentativa: não trava — só muda o modo visual
          role = 'client';
          clientData = Object.assign({}, baseEditorProfile, { kind:'client' });
          lsSet(LS_CLIENT, clientData);
          setActiveSession('client');
          closeUserMenu();
          showScreen(screenClientProfile, true);
          hideLoading();
          return;
        }

        role = 'client';
        applyAccountToSession('client', acc);
        setActiveSession('client');
        closeUserMenu();
        showScreen(screenClientProfile, true);
      }catch(e){
        console.error(e);
        try{
          role = 'client';
          setActiveSession('client');
          closeUserMenu();
          showScreen(screenClientProfile, true);
        }catch(_){}
      }
      hideLoading();
    }



    function lsGet(key, fallback){
      try{
        const raw = localStorage.getItem(key);
        if(!raw) return fallback;
        return JSON.parse(raw);
      }catch(e){ return fallback; }
    }
    function lsSet(key, value){
      try{ localStorage.setItem(key, JSON.stringify(value)); }catch(e){}
    }


// ===== UI State (BETA) - Persistência para não voltar do início ao recarregar =====
// Salva o mínimo necessário no localStorage (tela atual + seleções + pedido ativo).
const LS_UI_STATE = 'karameloo_ui_state_v1';
let __uiSaveTimer = null;

function uiGetState(){ return lsGet(LS_UI_STATE, null); }
function uiSetState(state){ lsSet(LS_UI_STATE, state); }

function uiScreenIdFromEl(el){
  try{ return el?.id || null; }catch(e){ return null; }
}
function uiCurrentVisibleScreenId(){
  const s = document.querySelector('.screen.show');
  return uiScreenIdFromEl(s) || 'screenStart';
}

function uiSnapshot(){
  // evita exceptions quebrando o site
  let selectedEditor = null;
  try{
    if(typeof selectedEditorFromProcurar !== 'undefined' && selectedEditorFromProcurar){
      selectedEditor = {
        id: selectedEditorFromProcurar.id,
        name: selectedEditorFromProcurar.name,
        rating: selectedEditorFromProcurar.rating ?? selectedEditorFromProcurar.stars ?? null,
        tags: selectedEditorFromProcurar.tags || [],
        packages: selectedEditorFromProcurar.packages || []
      };
    }
  }catch(e){}

  let co = null;
  try{
    // currentOrder é um objeto simples; clonamos pra não levar referências
    co = currentOrder ? JSON.parse(JSON.stringify(currentOrder)) : null;
  }catch(e){
    co = null;
  }

  let ao = null;
  try{ ao = (typeof activeOrderId !== 'undefined') ? (activeOrderId || null) : null; }catch(e){ ao = null; }

  let overlayOpen = false;
  try{ overlayOpen = !!(orderOverlay && orderOverlay.classList.contains('show')); }catch(e){ overlayOpen = false; }

  let chatOpen = false;
  try{ chatOpen = !!(chatOverlay && chatOverlay.classList.contains('show')); }catch(e){ chatOpen = false; }

  return {
    v: 1,
    ts: Date.now(),
    screenId: uiCurrentVisibleScreenId(),
    role: (typeof role !== 'undefined') ? role : null,
    currentOrder: co,
    selectedEditor,
    activeOrderId: ao,
    orderOverlayOpen: overlayOpen,
    chatOverlayOpen: chatOpen
  };
}

function uiSaveNow(){
  try{
    uiSetState(uiSnapshot());
  }catch(e){}
}
function uiSaveDebounced(){
  try{
    if(__uiSaveTimer) clearTimeout(__uiSaveTimer);
    __uiSaveTimer = setTimeout(()=>{ uiSaveNow(); }, 120);
  }catch(e){}
}

function uiRestore(){
  const st = uiGetState();
  if(!st || !st.screenId) return;

  // restaura variáveis principais
  try{ if(st.role) role = st.role; }catch(e){}
  try{
    if(st.selectedEditor){
      selectedEditorFromProcurar = st.selectedEditor;
    }
  }catch(e){}
  try{
    if(st.currentOrder){
      currentOrder = st.currentOrder;
    }
  }catch(e){}
  try{
    if(typeof activeOrderId !== 'undefined' && st.activeOrderId){
      activeOrderId = st.activeOrderId;
    }
  }catch(e){}

  // restaura tela
  try{
    if(st.screenId === 'screenCheckout'){
      const o = (typeof getOrderById === 'function' && (activeOrderId || st.activeOrderId)) ? getOrderById(activeOrderId || st.activeOrderId) : null;
      if(o && typeof showCheckoutForOrder === 'function'){
        showCheckoutForOrder(o);
      }else{
        // fallback
        const el = document.getElementById('screenClientProfile') || document.getElementById('screenStart');
        if(el && typeof showScreen === 'function') showScreen(el, true);
      }
    }else if(st.screenId === 'screenPickEditor'){
      if(currentOrder && typeof startPickEditor === 'function'){
        startPickEditor();
      }else{
        const el = document.getElementById('screenClient') || document.getElementById('screenStart');
        if(el && typeof showScreen === 'function') showScreen(el, true);
      }
    }else if(st.screenId === 'screenClient'){
      try{ if(typeof paintClientTop === 'function') paintClientTop(); }catch(e){}
      try{ if(typeof renderPackages === 'function') renderPackages(); }catch(e){}
      const el = document.getElementById('screenClient');
      if(el && typeof showScreen === 'function') showScreen(el, true);
    }else{
      const el = document.getElementById(st.screenId) || document.getElementById('screenStart');
      if(el && typeof showScreen === 'function') showScreen(el, true);
    }
  }catch(e){}

  // reabre overlays se o usuário estava neles
  try{
    if(st.orderOverlayOpen && typeof openOrderConfirm === 'function' && currentOrder){
      openOrderConfirm();
    }
  }catch(e){}
  try{
    if(st.chatOverlayOpen && typeof openChatForOrder === 'function' && (activeOrderId || st.activeOrderId)){
      openChatForOrder(activeOrderId || st.activeOrderId);
    }
  }catch(e){}

  // salva de novo para garantir consistência
  uiSaveDebounced();
}

// salva sempre que sair/atualizar
window.addEventListener('beforeunload', ()=>{ try{ uiSaveNow(); }catch(e){} });

    // ===== Base (screens) =====
    const titleCadastro = document.getElementById('titleCadastro');
    const btnCadastrar = document.getElementById('btnCadastrar');

    const screenStart = document.getElementById('screenStart');
    const screenProcurar = document.getElementById('screenProcurar');
    const screenProcurarEditor = document.getElementById('screenProcurarEditor');
    const screenClientProfile = document.getElementById('screenClientProfile');
    const screenClient = document.getElementById('screenClient');
    const screenPickEditor = document.getElementById('screenPickEditor');
    const screenEditor = document.getElementById('screenEditor');
    const screenAuth = document.getElementById('screenAuth');

        const screenCheckout = document.getElementById('screenCheckout');

const siteHeader = document.getElementById('siteHeader');

    // ===== Global Loader =====
    const globalLoader = document.getElementById('globalLoader');
    const globalLoaderText = document.getElementById('globalLoaderText');
    const globalLoaderSub = document.getElementById('globalLoaderSub');
    let __loaderStart = 0;
    let __loaderHideTimer = null;

    function __nextPaint(){
      return new Promise(r => requestAnimationFrame(()=>requestAnimationFrame(r)));
    }
    function showLoading(msg, sub){
      if(!globalLoader) return;
      if(__loaderHideTimer){ clearTimeout(__loaderHideTimer); __loaderHideTimer = null; }
      __loaderStart = Date.now();
      if(globalLoaderText) globalLoaderText.textContent = msg || 'Carregando…';
      if(globalLoaderSub) globalLoaderSub.textContent = sub || 'Aguarde só um instante';
      globalLoader.classList.add('show');
      globalLoader.setAttribute('aria-hidden','false');
      try{ document.body.classList.add('no-scroll'); }catch(e){}
    }
    function hideLoading(){
      if(!globalLoader) return;
      const minMs = 520;
      const elapsed = Date.now() - (__loaderStart||0);
      const wait = Math.max(0, minMs - elapsed);
      if(__loaderHideTimer) clearTimeout(__loaderHideTimer);
      __loaderHideTimer = setTimeout(()=>{
        globalLoader.classList.remove('show');
        globalLoader.setAttribute('aria-hidden','true');
        try{ document.body.classList.remove('no-scroll'); }catch(e){}
      }, wait);
    }

    // ===== Helpers: open auth with loader + password eye =====
    

    // (Auth/Login removido a pedido do projeto)
    let role = null;
    let currentOrder = null;

// ===== CPF / Idade (demo) =====
    function cpfDigits(v){ return String(v||'').replace(/\D/g,'').slice(0,11); }
    function formatCPF(d){
      d = cpfDigits(d);
      if(d.length<=3) return d;
      if(d.length<=6) return d.slice(0,3)+'.'+d.slice(3);
      if(d.length<=9) return d.slice(0,3)+'.'+d.slice(3,6)+'.'+d.slice(6);
      return d.slice(0,3)+'.'+d.slice(3,6)+'.'+d.slice(6,9)+'-'+d.slice(9);
    }
    function isValidCPF(cpf){
      const d = cpfDigits(cpf);
      if(d.length !== 11) return false;
      if(/^([0-9])\1+$/.test(d)) return false;
      let sum=0; for(let i=0;i<9;i++) sum += parseInt(d.charAt(i),10)*(10-i);
      let check = 11 - (sum % 11); if(check>=10) check=0;
      if(check !== parseInt(d.charAt(9),10)) return false;
      sum=0; for(let i=0;i<10;i++) sum += parseInt(d.charAt(i),10)*(11-i);
      check = 11 - (sum % 11); if(check>=10) check=0;
      return check === parseInt(d.charAt(10),10);
    }
    function calcAge(isoDate){
      if(!isoDate) return NaN;
      const b = new Date(isoDate);
      if(isNaN(b.getTime())) return NaN;
      const n = new Date();
      let age = n.getFullYear() - b.getFullYear();
      const m = n.getMonth() - b.getMonth();
      if(m < 0 || (m===0 && n.getDate() < b.getDate())) age--;
      return age;
    }

    if(inCPF){
      inCPF.addEventListener('input', ()=>{
        const d = cpfDigits(inCPF.value);
        inCPF.value = formatCPF(d);
      });
    }


    function openCadastro(tipo){
      // Tela inteira (sem modal). Loader só aparece quando clicar em Entrar / Criar conta.
      if(typeof setRole === 'function') setRole(tipo || 'cliente'); else role = (tipo || 'cliente');
      resetAuthUI();

      // limpa campos (para nao misturar cadastros)
      if(inNome) inNome.value = '';
      if(inSobrenome) inSobrenome.value = '';
      if(inData) inData.value = '';
      if(inCPF) inCPF.value = '';
      if(inEmail) inEmail.value = '';
      if(inSenha) inSenha.value = '';
      if(inSenha2) inSenha2.value = '';
      if(loginEmail) loginEmail.value = '';
      if(loginSenha) loginSenha.value = '';

      // abre tela de auth
      showScreen(screenAuth, true);
      window.scrollTo(0,0);
      requestAnimationFrame(syncAuthWrapHeight);
    }
    function closeCadastro(){
      // volta para a tela inicial
      showScreen(screenStart, true);
      window.scrollTo(0,0);
    }

    // expõe funções para onclick inline
    window.openAuth = openAuth;
    window.openCadastro = openCadastro;
    window.closeCadastro = closeCadastro;

    window.addEventListener('resize', ()=>{
      if(screenAuth && screenAuth.classList.contains('show')) syncAuthWrapHeight();
    });

    function showScreen(which, instant=false){
      [screenStart, screenProcurar, screenProcurarEditor, screenClientProfile, screenClient, screenPickEditor, screenEditor, screenAuth].forEach(s => s.classList.remove('show'));

      // Mensagens (chat) só depois que o usuário entrou (não mostrar na tela inicial/login)
      const chatFabEl = document.getElementById('chatFab');
      if(chatFabEl){
        const isAuth = (which === screenStart || which === screenAuth);
        chatFabEl.style.display = isAuth ? 'none' : 'flex';
      }


      // Header grande só na tela inicial (tira a "marca gigantesca" depois que entra)
      if(siteHeader){
        siteHeader.style.display = (which === screenStart) ? '' : 'none';
      }

      const doShow = ()=>{
        which.classList.add('show');
        window.scrollTo({top:0, behavior: instant ? 'auto' : 'smooth'});
        try{ uiSaveDebounced(); }catch(e){}
      };

      if(instant) doShow();
      else setTimeout(doShow, 50);
    }
    function goBackStart(){ showScreen(screenStart,true); }
    function goStart(){ goBackStart(); }
    function goStartInstant(){ showScreen(screenStart,true); }

    // ===== Storage =====
    const LS_EDITOR = "karamello_editor_v6";
    const LS_CLIENT = "karamello_client_v2";

    const LS_ACCOUNTS = "karamello_accounts_v1";

    function normEmail(v){ return String(v||"").trim().toLowerCase(); }
    function roleKey(){ return (role === "cliente") ? "client" : "editor"; }
    function getAccounts(){ return lsGet(LS_ACCOUNTS, { client:{}, editor:{} }); }
    function setAccounts(obj){ lsSet(LS_ACCOUNTS, obj); }
    function findEmailByCPF(kind, cpfD){
      const acc = getAccounts();
      const m = acc?.[kind] || {};
      for(const k of Object.keys(m)){
        if(String(m[k]?.cpf||"") === String(cpfD)) return k;
      }
      return null;
    }

    

    // ===== Pacotes =====
    const packages = [
      {id:1,  name:'Starter Foto',     price:27.40, eta:'35min', items:['2 Fotos (básicas)','Cor + nitidez','Ajuste de luz/contraste']},
      {id:2,  name:'Duo Foto',         price:41.80, eta:'35min', items:['3 Fotos (básicas)','Cor + nitidez','Padronização simples']},

      {id:3,  name:'Foto Pro 3',       price:53.60, eta:'55min', items:['4 Fotos (pro)','Ajustes finos + cor','Retoque leve (detalhes)','Remoção de manchas (leve)','1 revisão inclusa']},
      {id:4,  name:'Vídeo Short 1min', price:63.90, eta:'55min', items:['2 Vídeos (até 1min)','Cortes + ritmo','Limpeza de áudio leve','Legenda básica (opcional)','1 revisão inclusa']},
      {id:5,  name:'Foto Pack 4',      price:73.50, eta:'1h10', items:['5 Fotos (pro)','Cor + detalhes','Retoque leve (pele/objetos)','Nitidez premium','1 revisão inclusa']},
      {id:6,  name:'Short Duo 1m30',   price:86.40, eta:'1h25', items:['3 Vídeos (até 1m30)','Cortes + transições simples','Correção de cor leve','SFX leves (opcional)','1 revisão inclusa']},
      {id:7,  name:'Combo Social',     price:96.80, eta:'1h45', items:['2 Fotos + 1 Vídeo (até 1min)','Look cinematográfico leve','Correção de cor','Legenda simples (opcional)','1 revisão inclusa']},
      {id:8,  name:'Foto Pack 5',      price:108.90,eta:'2h20', items:['6 Fotos (pro)','Padronização de cor','Retoque leve + nitidez premium','Remoção de objetos simples (1x)','1 revisão inclusa']},

      {id:9,  name:'Short Trio 2min',  price:132.70,eta:'2h20', items:['4 Vídeos (até 2min)','Cor + ritmo','Efeitos sonoros leves','Legenda básica (opcional)','1 revisão inclusa']},
      {id:10, name:'Foto Pack 8',      price:151.40,eta:'3h30', items:['9 Fotos (pro)','Cor + retoques leves','Remoção de objetos simples (1x)','Retoque avançado (selecionado)','1 revisão inclusa']},
      {id:11, name:'Short 5 3min',     price:176.90,eta:'3h30', items:['6 Vídeos (até 3min)','Cortes + cor','Áudio: redução de ruído','Legenda básica (opcional)','2 revisões inclusas']},
      {id:12, name:'Creator Mix Pro',  price:197.80,eta:'3h30', items:['12 Fotos + 1 Vídeo (até 5min)','Padronização completa','Thumbnail premium (1x)','Export 1080p/4K (se tiver)','2 revisões inclusas']},

      {id:13, name:'Vídeo Médio 8min', price:221.60,eta:'3h30', items:['1 Vídeo (até 8min)','Cor + transições','Áudio + legenda simples','Motion text leve (opcional)','2 revisões inclusas']},
      {id:14, name:'Vídeo Longo 15min',price:259.40,eta:'6h00', items:['1 Vídeo (até 15min)','Edição avançada + ritmo','Sound design (leve)','Thumbnail (1x)','3 revisões inclusas']},
      {id:15, name:'Premium Creator+', price:329.90,eta:'6h00', items:['18 Fotos (pro)','4 Vídeos (até 15min cada)','Look premium + revisão','Prioridade (fila rápida)','3 revisões inclusas']},
    ];
// ===== NÍVEL DO EDITOR (Iniciante / Intermediário / Avançado) =====
// Regra: os preços atuais são do nível AVANÇADO (não mudam).
let PRICE_TIER = (localStorage.getItem('karameloo_price_tier') || 'avancado');

function tierMultiplier(){
  if(PRICE_TIER === 'intermediario') return 0.86;
  if(PRICE_TIER === 'iniciante') return 0.74;
  return 1.0; // avançado

}

function normTier(v){
  return String(v||'')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g,'')  // remove acentos
    .replace(/\s+/g,'')
    .trim();
}



function marketRoundBRL(value, seed){
  // "Jogo de mercado": evita números redondos e cria preços psicológicos.
  // Ex.: termina em ,90 / ,80 / ,70 / ,60 / ,40 (determinístico pelo seed)
  const patterns = [0.90, 0.80, 0.70, 0.60, 0.40];
  const p = patterns[Math.abs(seed) % patterns.length];
  let v = Math.max(0, value);
  // base em inteiro + centavos padrão
  let base = Math.floor(v);
  let out = base + p;
  // garante que não fique acima do valor original (para não "subir" o desconto)
  if(out > v) out = Math.max(0, out - 0.10);
  // se ficou muito abaixo (por causa do floor), aproxima um pouco
  if(v - out > 1.20) out = base + patterns[(Math.abs(seed)+1)%patterns.length];
  return Math.round(out * 100) / 100;
}

function priceForTier(basePrice, seed){
  if(PRICE_TIER === 'avancado') return basePrice;
  const mult = tierMultiplier();
  const discounted = basePrice * mult;
  // seed muda por tier também
  const tierSeed = seed + (PRICE_TIER === 'iniciante' ? 13 : 7);
  return marketRoundBRL(discounted, tierSeed);
}

function packagePrice(p){
  return priceForTier(Number(p.price||0), Number(p.id||0));
}

function setPriceTier(tier){
  PRICE_TIER = (tier === 'iniciante' || tier === 'intermediario' || tier === 'avancado') ? tier : 'avancado';
  localStorage.setItem('karameloo_price_tier', PRICE_TIER);
  // UI
  const wrap = document.getElementById('tierTogglePackages');
  if(wrap){
    wrap.querySelectorAll('.tier-btn').forEach(btn=>{
      const active = btn.getAttribute('data-tier') === PRICE_TIER;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-selected', active ? 'true' : 'false');
    });
  }
  // Re-render preços
  if(typeof renderPackages === 'function') renderPackages();
  if(typeof calcCustom === 'function') calcCustom();
}

function initTierToggle(){
  const wrap = document.getElementById('tierTogglePackages');
  if(!wrap) return;
  wrap.addEventListener('click', (e)=>{
    const btn = e.target && e.target.closest ? e.target.closest('.tier-btn') : null;
    if(!btn) return;
    setPriceTier(btn.getAttribute('data-tier'));
  });
  // estado inicial
  setPriceTier(PRICE_TIER);
}


    function renderPackages(){
      const grid = document.getElementById('packagesGrid');
      if(!grid) return;

      // Se o cliente veio da tela Explorar, mostramos só os pacotes que esse editor aceita
      const ctx = document.getElementById('clientEditorContext');
      let arr = packages.slice();
      if(typeof selectedEditorFromProcurar !== 'undefined' && selectedEditorFromProcurar){
        const allow = new Set((selectedEditorFromProcurar.packages||[]).map(n=>Number(n)));
        arr = arr.filter(p=>allow.has(p.id));
        if(ctx){
          ctx.style.display = '';
          ctx.innerHTML = `Editor selecionado: <strong>${escapeHtml(selectedEditorFromProcurar.name)}</strong> • Pacotes: <strong>${arr.length}</strong> <span style="opacity:.85">(voltar para procurar para trocar)</span>`;
        }
      }else{
        if(ctx){ ctx.style.display='none'; ctx.textContent=''; }
      }

      grid.innerHTML = '';
      arr.forEach(p => {
        const card = document.createElement('div');
        card.className = 'card';
        const nm = (p.name||'').toLowerCase();
        const th = nm.includes('foto') ? presetToCover('graphite') : (nm.includes('vídeo') || nm.includes('video') || nm.includes('short') ? presetToCover('gold') : presetToCover('amber'));
        if(th) card.style.setProperty('--pkgthumb', th);
        card.style.setProperty('--pkgpattern', pkgPattern(p.id));
        card.innerHTML = `
          <div class="pkgThumb"></div>
          <h3>${p.id}. ${escapeHtml(p.name)}</h3>
          <p>Entrega a partir de <strong>${escapeHtml(p.eta)}</strong> (mínimo 35min)</p>
          <div class="price">${brl(packagePrice(p))}</div>
          <ul>${p.items.map(i=>`<li>${escapeHtml(i)}</li>`).join('')}</ul>
          <button class="btn" type="button" data-action="choose-package" data-package-id="${p.id}">Escolher pacote</button>
        `;
        grid.appendChild(card);
      });

      if(selectedEditorFromProcurar && !arr.length){
        grid.innerHTML = `
          <div class="card full" style="grid-column:1/-1">
            <h3>Esse editor ainda não selecionou pacotes</h3>
            <p>Volte para explorar e escolha outro editor, ou peça um Personalizado.</p>
          </div>`;
      }
    }



    // ===== EXPLORAR (Marketplace) =====
    const LS_API_BASE = 'karamelo_api_base_v1';
    const LS_FAV_EDITORS = 'karamelo_fav_editors_v1';
    const LS_RECENT_EDITORS = 'karamelo_recent_editors_v1';

    let exploreFilter = 'all';
    let exploreEditorsCache = [];
    let exploreEditorsById = {};
    let selectedEditorFromProcurar = null; // editor selecionado (para filtrar pacotes)

    // intenção pós-login (fluxo A: navegar livre, e só criar conta ao falar/contratar)
    let postLoginIntent = null; // {type:'chat'|'package', editorId?, packageId?}
    function setPostLoginIntent(intent){ postLoginIntent = intent; }
    function runPostLoginIntent(){
      const intent = postLoginIntent;
      if(!intent) return;
      postLoginIntent = null;
      if(intent.type==='chat' && intent.editorId){
        try{ openEditorProfile(String(intent.editorId)); }catch(e){}
        setTimeout(()=>{ try{ openChatWithEditor(String(intent.editorId)); }catch(e){} }, 140);
        return;
      }
      if(intent.type==='package'){
        // abre pacotes (demo)
        try{ paintClientTop(); selectedEditorFromProcurar = null; renderPackages(); showScreen(screenClient); }catch(e){}
      }
    }


    const exploreEditorsGrid = document.getElementById('exploreEditorsGrid');
    const exploreSearch = document.getElementById('exploreSearch');
    const exploreSort = document.getElementById('exploreSort');
    const exploreAvatar = document.getElementById('exploreAvatar');
    const exploreSubtitle = document.getElementById('exploreSubtitle');
    const exploreHint = document.getElementById('exploreHint');
    const exploreBackendStatus = document.getElementById('exploreBackendStatus');
    const exploreWelcomeName = document.getElementById('exploreWelcomeName');
    const exploreEditorsCarousel = document.getElementById('exploreEditorsCarousel');
    const marketCats = document.getElementById('marketCats');

    // Editor -> explorar clientes
    const LS_FAV_CLIENTS = 'karamelo_fav_clients_v1';
    let exploreEFilter = 'all';
    const exploreESearch = document.getElementById('exploreESearch');
    const exploreESort = document.getElementById('exploreESort');
    const exploreEWelcomeName = document.getElementById('exploreEWelcomeName');
    const exploreESubtitle = document.getElementById('exploreESubtitle');
    const exploreEHint = document.getElementById('exploreEHint');
    const exploreClientsGrid = document.getElementById('exploreClientsGrid');
    const exploreClientsCarousel = document.getElementById('exploreClientsCarousel');
    const marketCatsE = document.getElementById('marketCatsE');

    const btnProcurarProfile = document.getElementById('btnProcurarProfile');

    const profileOverlay = document.getElementById('profileOverlay');
    const profileModal = document.getElementById('profileModal');
    const profileTitle = document.getElementById('profileTitle');
    const profileBody = document.getElementById('profileBody');

    
/* (removido chat antigo para evitar conflito) */

/* ===== Fiverr-like Chat (Beta / localStorage) ===== */
const chatOverlay = document.getElementById("chatOverlay");
const chatFab = document.getElementById("chatFab");
// Chat flutuante só deve aparecer quando o usuário estiver na área logada (cliente/editor)
function setChatFabVisible(visible){
  if(!chatFab) return;
  chatFab.style.display = visible ? "flex" : "none";
}
// começa escondido (tela inicial / cadastro)
setChatFabVisible(false);

const chatFabBadge = document.getElementById("chatFabBadge");
const chatThreadsEl = document.getElementById("chatThreads");
const chatMsgsEl = document.getElementById("chatMsgs");
const chatInput = document.getElementById("chatInput");
const chatSearchInput = document.getElementById("chatSearchInput");
const chatUnreadPill = document.getElementById("chatUnreadPill");

const chatPeerAvatar = document.getElementById("chatPeerAvatar");
const chatPeerName = document.getElementById("chatPeerName");
const chatPeerStatus = document.getElementById("chatPeerStatus");
const chatPeerSub = document.getElementById("chatPeerSub");
const chatShellSub = document.getElementById("chatShellSub");

const chatContextBar = document.getElementById("chatContextBar");
const chatContextPills = document.getElementById("chatContextPills");

let chatState = { active:null, last:null, threads:{}, ctx:null };

function chatStoreKey(){
  return "kml_chat_store_v2_" + clientChatId();
}
function chatLoad(){
  try{
    const raw = localStorage.getItem(chatStoreKey());
    if(raw){
      const obj = JSON.parse(raw);
      if(obj && typeof obj === "object"){
        chatState = Object.assign({active:null,last:null,threads:{},ctx:null}, obj);
      }
    }
  }catch(e){ /* ignore */ }
}
function chatSave(){
  try{
    localStorage.setItem(chatStoreKey(), JSON.stringify(chatState));
  }catch(e){ /* ignore */ }
}

function resolvePeer(editorOrId){
  // editorOrId can be: {id,name,whats} or string id
  if(!editorOrId) return null;
  if(typeof editorOrId === "object"){
    const name = editorOrId.name || editorOrId.fullName || editorOrId.displayName || "Editor";
    const id = editorOrId.id || ("peer_" + slug(name));
    return {
      id,
      name,
      whatsapp: editorOrId.whatsapp || editorOrId.whats || editorOrId.wa || "",
      online: (editorOrId.online ?? true)
    };
  }
  if(typeof editorOrId === "string"){
    const all = (typeof getAllEditors === "function") ? getAllEditors() : [];
    const found = all.find(e => String(e.id) === String(editorOrId)) || all.find(e => (e.name||"").toLowerCase() === editorOrId.toLowerCase());
    if(found){
      return { id: found.id, name: found.name || "Editor", whatsapp: found.whatsapp || found.whats || "", online: true };
    }
    return { id: editorOrId, name: editorOrId, whatsapp:"", online:true };
  }
  return null;
}

function chatEnsureThread(peer){
  if(!peer || !peer.id) return;
  if(!chatState.threads) chatState.threads = {};
  if(!chatState.threads[peer.id]){
    // migrate old localStorage thread if exists
    const oldKey = "kml_chat_" + clientChatId() + "_" + peer.id;
    let msgs = [];
    try{
      const oldRaw = localStorage.getItem(oldKey);
      if(oldRaw){
        const old = JSON.parse(oldRaw);
        if(Array.isArray(old)) msgs = old;
      }
    }catch(e){}
    chatState.threads[peer.id] = {
      peerId: peer.id,
      peerName: peer.name,
      peerWhatsapp: peer.whatsapp || "",
      unread: 0,
      updatedAt: Date.now(),
      messages: msgs.map(m => ({
        from: (m.from==="me" || m.from==="user") ? "me" : "them",
        text: m.text || "",
        ts: m.ts || Date.now()
      }))
    };
  }else{
    // update name/whats if changed
    chatState.threads[peer.id].peerName = peer.name || chatState.threads[peer.id].peerName;
    if(peer.whatsapp) chatState.threads[peer.id].peerWhatsapp = peer.whatsapp;
  }
  chatSave();
}

function chatOpenUI(){
  chatOverlay.classList.add("open");
  chatOverlay.setAttribute("aria-hidden","false");
  document.body.style.overflow = "hidden";
}

function chatOpenLast(){
  if(chatState.last){
    chatState.active = chatState.last;
    chatSave();
    chatOpenUI();
    chatRenderAll();
    chatMarkRead(chatState.active);
  }else{
    kmlToast("Você ainda não tem conversas.");
  }
}

function chatRenderAll(){
  chatRenderThreads();
  chatRenderActive();
  chatUpdateUnreadUI();
}

function chatRenderThreads(){
  const q = (chatSearchInput?.value || "").trim().toLowerCase();
  const list = Object.values(chatState.threads || {});
  list.sort((a,b) => (b.updatedAt||0) - (a.updatedAt||0));

  chatThreadsEl.innerHTML = "";
  let shown = 0;

  list.forEach(t=>{
    const name = (t.peerName || "Editor");
    const preview = getLastPreview(t);
    if(q && !(name.toLowerCase().includes(q) || preview.toLowerCase().includes(q))) return;

    shown++;
    const btn = document.createElement("div");
    btn.className = "threadItem" + (t.peerId === chatState.active ? " active" : "");
    btn.onclick = () => {
      chatState.active = t.peerId;
      chatState.last = t.peerId;
      chatSave();
      chatRenderAll();
      chatMarkRead(t.peerId);
      setTimeout(()=>chatScrollToBottom(true), 20);
    };

    const av = document.createElement("div");
    av.className = "threadAv";
    av.textContent = (name.trim()[0] || "E").toUpperCase();

    const main = document.createElement("div");
    main.className = "threadMain";

    const top = document.createElement("div");
    top.className = "threadTop";
    const nm = document.createElement("div");
    nm.className = "threadName";
    nm.textContent = name;
    const tm = document.createElement("div");
    tm.className = "threadTime";
    tm.textContent = formatTimeShort(t.updatedAt || Date.now());

    top.appendChild(nm); top.appendChild(tm);

    const prev = document.createElement("div");
    prev.className = "threadPreview";
    prev.textContent = preview || "—";

    main.appendChild(top);
    main.appendChild(prev);

    btn.appendChild(av);
    btn.appendChild(main);

    if((t.unread||0) > 0){
      const dot = document.createElement("div");
      dot.className = "unreadDot";
      dot.textContent = String(Math.min(99, t.unread));
      btn.appendChild(dot);
    }

    chatThreadsEl.appendChild(btn);
  });

  if(!shown){
    const empty = document.createElement("div");
    empty.style.padding = "14px 10px";
    empty.style.color = "rgba(255,255,255,.65)";
    empty.style.fontWeight = "800";
    empty.textContent = q ? "Nenhuma conversa encontrada." : "Sem conversas ainda. Abra um perfil e clique em “Falar com o editor”.";
    chatThreadsEl.appendChild(empty);
  }
}

function chatRenderActive(){
  const id = chatState.active;
  const t = id ? (chatState.threads || {})[id] : null;

  // header
  if(!t){
    chatPeerAvatar.textContent = "E";
    chatPeerName.textContent = "Selecione um editor";
    chatPeerStatus.textContent = "—";
    chatPeerSub.textContent = "Abra o perfil de um editor e clique em “Falar com o editor”.";
    chatMsgsEl.innerHTML = "";
    chatContextBar.style.display = "none";
    return;
  }

  const name = t.peerName || "Editor";
  chatPeerAvatar.textContent = (name.trim()[0] || "E").toUpperCase();
  chatPeerName.textContent = name;
  chatPeerStatus.textContent = "Online agora";
  chatPeerSub.textContent = "Responda com detalhes (prazo, plataforma, referências) pra fechar mais rápido.";
  chatShellSub.textContent = "Conversando com " + name;

  // context pills (optional)
  renderChatContext(chatState.ctx);

  // messages
  const msgs = t.messages || [];
  chatMsgsEl.innerHTML = "";
  msgs.forEach(m=>{
    const row = document.createElement("div");
    row.className = "chatMsgRow " + (m.from === "me" ? "me" : "them");

    const bubble = document.createElement("div");
    bubble.className = "chatBubble";
    bubble.textContent = m.text || "";

    const meta = document.createElement("div");
    meta.className = "chatMeta";
    meta.innerHTML = `<span>${m.from === "me" ? "Você" : name}</span><span>${formatTimeLong(m.ts || Date.now())}</span>`;

    bubble.appendChild(meta);
    row.appendChild(bubble);
    chatMsgsEl.appendChild(row);
  });

  if(!msgs.length){
    const row = document.createElement("div");
    row.style.color = "rgba(255,255,255,.65)";
    row.style.fontWeight = "800";
    row.style.padding = "8px 0";
    row.textContent = "Envie uma mensagem para iniciar a conversa.";
    chatMsgsEl.appendChild(row);
  }
}

function renderChatContext(ctx){
  if(!ctx){
    chatContextBar.style.display = "none";
    chatContextPills.innerHTML = "";
    return;
  }
  const pills = [];
  if(ctx.platform) pills.push("📱 " + ctx.platform);
  if(ctx.videoType) pills.push("🎬 " + ctx.videoType);
  if(ctx.deadline) pills.push("⏱️ " + ctx.deadline);
  if(ctx.total) pills.push("💰 Total: " + ctx.total);
  if(ctx.orderId) pills.push("🧾 Pedido: " + ctx.orderId);

  if(pills.length){
    chatContextBar.style.display = "";
    chatContextPills.innerHTML = pills.map(p=>`<span class="ctxP">${escapeHtml(p)}</span>`).join("");
  }else{
    chatContextBar.style.display = "none";
    chatContextPills.innerHTML = "";
  }
}

function chatUpdateUnreadUI(){
  const total = Object.values(chatState.threads||{}).reduce((acc,t)=>acc + (t.unread||0), 0);
  if(total > 0){
    chatFabBadge.style.display = "";
    chatFabBadge.textContent = String(Math.min(99,total));
  }else{
    chatFabBadge.style.display = "none";
  }
  chatUnreadPill.textContent = `${total} não lidas`;
}

function chatMarkRead(peerId){
  const t = (chatState.threads||{})[peerId];
  if(!t) return;
  t.unread = 0;
  chatSave();
  chatUpdateUnreadUI();
  // re-render threads to remove badge
  chatRenderThreads();
}

function chatMarkAllRead(){
  Object.values(chatState.threads||{}).forEach(t=> t.unread = 0);
  chatSave();
  chatRenderAll();
}

function sendChat(){
  const id = chatState.active;
  if(!id){
    kmlToast("Abra um editor para conversar.");
    return;
  }
  const t = (chatState.threads||{})[id];
  if(!t) return;

  const text = (chatInput.value || "").trim();
  if(!text) return;

  const msg = { from:"me", text, ts: Date.now() };
  t.messages = t.messages || [];
  t.messages.push(msg);
  t.updatedAt = Date.now();
  chatInput.value = "";
  chatSave();
  chatRenderAll();
  chatScrollToBottom();

  // Simular resposta do editor (demo)
  setTimeout(()=>{
    const reply = {
      from:"them",
      text: demoReply(text),
      ts: Date.now()
    };
    t.messages.push(reply);
    t.updatedAt = Date.now();
    if(chatState.active !== id) t.unread = (t.unread||0) + 1; // if user moved away
    chatSave();
    chatRenderAll();
    if(chatState.active === id) chatScrollToBottom();
  }, 650 + Math.random()*550);
}

function demoReply(userText){
  const s = (userText||"").toLowerCase();
  if(s.includes("prazo")) return "Show! Me fala o prazo que você precisa e se é urgente (posso priorizar).";
  if(s.includes("plataforma") || s.includes("tiktok") || s.includes("reels") || s.includes("shorts")) return "Perfeito. Qual plataforma e duração do vídeo (15/45/60)?";
  if(s.includes("valor") || s.includes("preço")) return "Me manda o briefing (quantidade, duração e referências) que eu já te passo uma estimativa certinha.";
  if(s.includes("oi") || s.includes("olá")) return "Fala! 👋 Você prefere cortes rápidos ou mais cinematográfico?";
  return "Boa! Me envia referências e o estilo que você quer (e se tem música/legendas).";
}

function getLastPreview(t){
  const m = (t.messages||[])[(t.messages||[]).length-1];
  return m ? (m.text||"") : "";
}

function chatScrollToBottom(force=false){
  if(!chatMsgsEl) return;
  if(force){
    chatMsgsEl.scrollTop = chatMsgsEl.scrollHeight;
    return;
  }
  const nearBottom = (chatMsgsEl.scrollHeight - chatMsgsEl.scrollTop - chatMsgsEl.clientHeight) < 180;
  if(nearBottom) chatMsgsEl.scrollTop = chatMsgsEl.scrollHeight;
}

function chatOpenWhats(){
  const id = chatState.active;
  if(!id) return;
  const t = (chatState.threads||{})[id];
  const wa = (t && t.peerWhatsapp) ? String(t.peerWhatsapp).replace(/\D/g,"") : "";
  if(!wa){
    kmlToast("Esse editor não cadastrou Whats ainda.");
    return;
  }
  window.open("https://wa.me/" + wa, "_blank");
}

function chatOpenPeerProfile(){
  const id = chatState.active;
  if(!id) return;
  if(typeof openEditorProfile === "function"){
    openEditorProfile(id);
  }else{
    kmlToast("Perfil: em breve.");
  }
}

/* ===== Inbox Button / Events ===== */
if(chatFab){
  chatFab.addEventListener("click", ()=>{
    chatOpenLast();
  });
}

chatOverlay?.addEventListener("click", (e)=>{
  if(e.target === chatOverlay) closeChat();
});

chatSearchInput?.addEventListener("input", ()=> chatRenderThreads());

chatInput?.addEventListener("keydown", (e)=>{
  if(e.key === "Enter" && !e.shiftKey){
    e.preventDefault();
    sendChat();
  }
});

window.addEventListener("keydown", (e)=>{
  if(e.key === "Escape" && chatOverlay?.classList.contains("open")) closeChat();
});

/* ===== Sidebar Navigation ===== */
function navGo(where){
  try{
    if(where === "home"){
      window.scrollTo({top:0, behavior:"smooth"});
      return;
    }
    if(where === "editors"){
      const el = document.getElementById("editorsGrid");
      if(el) el.scrollIntoView({behavior:"smooth", block:"start"});
      return;
    }
    if(where === "pkgs"){
      const btn = document.querySelector('.catBtn[data-filter="pkgs"]');
      if(btn) btn.click();
      const el = document.getElementById("editorsGrid");
      if(el) setTimeout(()=>el.scrollIntoView({behavior:"smooth", block:"start"}), 120);
      return;
    }
    if(where === "fav"){
      const btn = document.querySelector('.catBtn[data-filter="fav"]');
      if(btn) btn.click();
      const el = document.getElementById("editorsGrid");
      if(el) setTimeout(()=>el.scrollIntoView({behavior:"smooth", block:"start"}), 120);
      return;
    }
    if(where === "profile"){
      kmlToast("Perfil (beta): vamos colocar completo quando tiver backend.");
      return;
    }
    if(where === "settings"){
      kmlToast("Configurações (beta): vamos colocar completo quando tiver backend.");
      return;
    }
    if(where === "support"){
      kmlToast("Suporte: em breve (FAQ + ticket).");
      return;
    }
  }catch(e){
    console.error(e);
  }
}

/* ===== Utils ===== */
function formatTimeShort(ts){
  const d = new Date(ts || Date.now());
  const hh = String(d.getHours()).padStart(2,"0");
  const mm = String(d.getMinutes()).padStart(2,"0");
  return `${hh}:${mm}`;
}
function formatTimeLong(ts){
  const d = new Date(ts || Date.now());
  const hh = String(d.getHours()).padStart(2,"0");
  const mm = String(d.getMinutes()).padStart(2,"0");
  return `${hh}:${mm}`;
}
function slug(s){
  return String(s||"").toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/(^-|-$)/g,"");
}
function escapeHtml(str){
  return String(str||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#039;");
}
function kmlToast(msg){
  const t = document.createElement("div");
  t.textContent = msg;
  t.style.position="fixed";
  t.style.left="50%";
  t.style.bottom="22px";
  t.style.transform="translateX(-50%)";
  t.style.zIndex="10000";
  t.style.background="rgba(10,10,12,.86)";
  t.style.border="1px solid rgba(255,255,255,.12)";
  t.style.backdropFilter="blur(12px)";
  t.style.padding="10px 12px";
  t.style.borderRadius="14px";
  t.style.color="rgba(255,255,255,.92)";
  t.style.fontWeight="800";
  t.style.boxShadow="0 18px 50px rgba(0,0,0,.45)";
  document.body.appendChild(t);
  setTimeout(()=>{ t.style.opacity="0"; t.style.transition="opacity .25s ease"; }, 1700);
  setTimeout(()=>{ t.remove(); }, 2100);
}

/* init */
chatLoad();
chatUpdateUnreadUI();


function openOrderConfirm(){
      if(!currentOrder){
        alert('Selecione um pacote/pedido primeiro.');
        return;
      }
      ensureOrderHasEditor();
      if(!currentOrder.editor){
        alert('Selecione um editor para continuar.');
        return;
      }

      // Preenche resumo
      const title = currentOrder.kind === 'package' ? currentOrder.title : 'Pacote Personalizado';
      const totalText = currentOrder.kind === 'package' ? brl(currentOrder.total || 0) : (currentOrder.totalText || brl(0));
      const eta = currentOrder.eta || '—';
      const editorName = currentOrder.editor?.name || 'Editor';
      const editorRate = (currentOrder.editor?.rating ?? START_STARS);
      const needLogin = !!currentOrder.needsLogin;

      if(orderSummary){
        orderSummary.innerHTML = `
          <h3 style="margin-top:0">Resumo</h3>
          <div class="pill" style="display:flex; gap:12px; flex-wrap:wrap">
            <span><b>Serviço:</b> ${escapeHtml(title)}</span>
            <span><b>Total:</b> ${escapeHtml(totalText)}</span>
            <span><b>Entrega:</b> ${escapeHtml(eta)}</span>
          </div>
          <div class="pill" style="margin-top:10px"><b>Editor:</b> ${escapeHtml(editorName)} • <b>Avaliação:</b> ${escapeHtml(String(editorRate))}/${MAX_STARS} ⭐</div>
          ${needLogin ? `<div class="hint" style="margin-top:10px">* Você não está logado. No beta dá para testar, mas no lançamento vamos exigir login para finalizar.</div>` : ``}
        `;
      }

      if(btnGoPay){
        btnGoPay.onclick = () => { void goToPaymentFromConfirm(); };
      }

      if(orderOverlay){
        orderOverlay.classList.remove('closing');
        orderModal?.classList.remove('closing');
        orderOverlay.classList.add('show');
        orderOverlay.setAttribute('aria-hidden','false');
      }
    }

    function closeOrderConfirm(){
      if(!orderOverlay) return;
      orderOverlay.classList.add('closing');
      orderModal?.classList.add('closing');
      setTimeout(()=>{
        orderOverlay.classList.remove('show','closing');
        orderModal?.classList.remove('closing');
        orderOverlay.setAttribute('aria-hidden','true');
      }, 220);
    }

    function buildPixPayload(order){
      const id = escapeHtml(String(order?.id || 'LOCAL'));
      const total = escapeHtml(order?.totalText || brl(order?.total || 0));
      // Placeholder PIX (beta)
      return `PIX-BETA|KARAMELOO|PEDIDO:${id}|TOTAL:${total}|GERADO:${new Date().toLocaleString('pt-BR')}`;
    }

    async function goToPaymentFromConfirm(){
      try{
        if(btnGoPay){ btnGoPay.disabled = true; btnGoPay.textContent = 'Gerando pedido...'; }

        // Cria e salva pedido
        const saved = await createOrderAndFinish();
        if(!saved) throw new Error('Pedido não foi criado');

        upsertOrder(saved);
        activeOrderId = saved.id || saved?._supa?.id || null;

        try{ uiSaveDebounced(); }catch(e){}

        // Abre checkout
        showCheckoutForOrder(saved);

        // fecha modal
        closeOrderConfirm();
      }catch(err){
        console.error(err);
        alert('Não foi possível criar o pedido. Abra o Console (F12) e me mande o erro.');
      }finally{
        if(btnGoPay){ btnGoPay.disabled = false; btnGoPay.textContent = 'Ir para pagamento'; }
      }
    }

    function showCheckoutForOrder(order){
      const o = order || (activeOrderId ? getOrderById(activeOrderId) : null) || currentOrder;
      if(!o) return;

      const title = o.kind === 'package' ? o.title : 'Pacote Personalizado';
      const totalText = o.totalText || brl(o.total || 0);
      const eta = o.eta || '—';
      const editorName = o.editor?.name || '—';

      if(checkoutOrderTitle) checkoutOrderTitle.textContent = `${title}`;
      if(checkoutOrderMeta) checkoutOrderMeta.textContent = `Editor: ${editorName} • Total: ${totalText} • Entrega: ${eta} • ID: ${o.id || 'LOCAL'}`;
      if(checkoutStatus) checkoutStatus.textContent = statusLabel(o.status || 'AWAITING_PAYMENT');
      if(checkoutPixCode) checkoutPixCode.value = buildPixPayload(o);

      // habilita chat só se pago
      const paid = String(o.status||'').toUpperCase() !== 'AWAITING_PAYMENT';
      if(btnOpenOrderChat){
        btnOpenOrderChat.disabled = !paid;
      }

      showScreen(screenCheckout, true);
    }

    function openChatForOrder(orderId){
      const o = getOrderById(orderId) || null;
      if(!o){
        alert('Pedido não encontrado.');
        return;
      }
      if(String(o.status||'').toUpperCase()==='AWAITING_PAYMENT'){
        alert('Confirme o pagamento para liberar o chat.');
        return;
      }
      // configura chatCtx para usar chave por pedido
      const peerName = o.editor?.name || 'Editor';
      chatCtx = {
        peerId: o.editor?.id || 'editor',
        peerName,
        peerWhats: '',
        key: `karamelo_chat_order_${o.id}`
      };
      if(chatTitle) chatTitle.textContent = `Chat do pedido • ${peerName}`;
      renderChat();
      if(chatOverlay){
        chatOverlay.classList.remove('closing');
        chatModal?.classList.remove('closing');
        chatOverlay.classList.add('show');
        chatOverlay.setAttribute('aria-hidden','false');
        setTimeout(()=> chatInput?.focus(), 60);
      }
    }

    // Checkout buttons
    btnCopyPix?.addEventListener('click', ()=>{
      try{
        checkoutPixCode?.select();
        document.execCommand('copy');
      }catch(e){}
      try{ navigator.clipboard?.writeText(checkoutPixCode?.value || ''); }catch(e){}
      toast && toast('PIX copiado!');
    });

    btnConfirmPaid?.addEventListener('click', ()=>{
      if(!activeOrderId){
        alert('Nenhum pedido ativo para confirmar.');
        return;
      }
      const updated = setOrderStatus(activeOrderId, 'PAID');
      if(updated){
        if(checkoutStatus) checkoutStatus.textContent = statusLabel(updated.status);
        if(btnOpenOrderChat) btnOpenOrderChat.disabled = false;
        toast && toast('Pagamento confirmado (BETA). Chat liberado!');
        try{ uiSaveDebounced(); }catch(e){}
      }
    });

    btnOpenOrderChat?.addEventListener('click', ()=>{
      if(!activeOrderId) return;
      openChatForOrder(activeOrderId);
    });



function startPickEditor(){
      const pickInfo = document.getElementById('pickInfo');
      const pickRatingChip = document.getElementById('pickRatingChip');
      if(pickRatingChip) pickRatingChip.textContent = `Avaliação: ${START_STARS.toFixed(0)}/${MAX_STARS} ⭐`;

      if(currentOrder?.kind === 'package'){
        if(pickInfo) pickInfo.textContent = `Pedido: ${currentOrder.title} • ${brl(currentOrder.total)} • ${currentOrder.eta}`;
      }else{
        if(pickInfo) pickInfo.textContent = `Pedido: Personalizado • ${currentOrder.totalText} • ${currentOrder.eta}`;
      }

      // Mostra a tela primeiro (para não parecer que “não aconteceu nada”)
      showScreen(screenPickEditor);

      // Render com proteção (se der erro, ainda assim o usuário vê feedback)
      try{
        renderPickEditors();
      }catch(err){
        console.error('renderPickEditors error:', err);
        const grid = document.getElementById('editorsGrid');
        if(grid){
          grid.innerHTML = `<div class="card full" style="grid-column:1/-1">
            <h3>Ops! Algo deu errado ao carregar os editores</h3>
            <p>Abra o Console (F12) e me mande o erro que apareceu. Eu arrumo na hora.</p>
          </div>`;
        }
      }
    }

    function backToOrder(){ showScreen(screenClient); }

    // ===== EDITOR (dashboard) =====
    const editorAvatarBox = document.getElementById('editorAvatarBox');
    const editorFullName = document.getElementById('editorFullName');
    const editorStars = document.getElementById('editorStars');

    const editorPhoto = document.getElementById('editorPhoto');
    const edAvailable = document.getElementById('edAvailable');
    const edAvailText = document.getElementById('edAvailText');

    const edRatingTxt = document.getElementById('edRatingTxt');
    const edStarsRow = document.getElementById('edStarsRow');
    const edDone = document.getElementById('edDone');
    const edStatus = document.getElementById('edStatus');

    const edXp = document.getElementById('edXp');
    const edWhats = document.getElementById('edWhats');
    const edBio = document.getElementById('edBio');
    const edSoft = document.getElementById('edSoft');
    const edPortfolio = document.getElementById('edPortfolio');
    const edTags = document.getElementById('edTags');
    const edTagsPreview = document.getElementById('edTagsPreview');

    const edSearchPkg = document.getElementById('edSearchPkg');
    const edQuick = document.getElementById('edQuick');
    const edPkgCount = document.getElementById('edPkgCount');
    const edPkgHint = document.getElementById('edPkgHint');
    const edPublicPreview = document.getElementById('edPublicPreview');

    let editorData = lsGet(LS_EDITOR, null);

    // ===== Portfólio (Editor) - demo (não salva em localStorage por tamanho) =====
    let workPhotos = []; // object URLs
    let workVideos = []; // object URLs

    function updateWorkUI(){
      const c = document.getElementById('edWorkCount');
      const g = document.getElementById('edWorkGrid');
      if(c) c.textContent = `${workPhotos.length}/${MAX_WORK_PHOTOS} fotos • ${workVideos.length}/${MAX_WORK_VIDEOS} vídeos`;
      if(!g) return;
      g.innerHTML = '';
      const addItem = (node)=>{
        const wrap = document.createElement('div');
        wrap.className='work-item';
        wrap.appendChild(node);
        g.appendChild(wrap);
      };
      workPhotos.forEach(url=>{
        const img=document.createElement('img');
        img.src=url;
        img.loading='lazy';
        addItem(img);
      });
      workVideos.forEach(url=>{
        const v=document.createElement('video');
        v.src=url;
        v.muted=true;
        v.playsInline=true;
        v.controls=true;
        addItem(v);
      });
    }

    function clearEditorWorks(){
      workPhotos.forEach(u=>{ try{ URL.revokeObjectURL(u);}catch(e){} });
      workVideos.forEach(u=>{ try{ URL.revokeObjectURL(u);}catch(e){} });
      workPhotos=[]; workVideos=[];
      const inP=document.getElementById('edWorkPhotos');
      const inV=document.getElementById('edWorkVideos');
      if(inP) inP.value='';
      if(inV) inV.value='';
      updateWorkUI();
    }

    function addFilesToWork(type, files){
      const arr = (type==='photo') ? workPhotos : workVideos;
      const max = (type==='photo') ? MAX_WORK_PHOTOS : MAX_WORK_VIDEOS;
      const left = Math.max(0, max - arr.length);
      const list = Array.from(files||[]).slice(0, left);
      if((files||[]).length > left){
        alert(`Limite atingido: no máximo ${max} ${type==='photo'?'fotos':'vídeos'}.`);
      }
      list.forEach(f=>{
        try{ arr.push(URL.createObjectURL(f)); }catch(e){}
      });
      updateWorkUI();
    }



    function ensureEditorData(nome, sobrenome){
      const full = `${nome} ${sobrenome}`.trim();
      editorData = editorData || {
        first:nome||'Editor',
        last:sobrenome||'',
        full: full || 'Editor',
        stars: START_STARS,
        photo:'',
        cover:{preset:'none', img:''},
        available:false,
        xp:'iniciante',
        whats:'',
        bio:'',
        soft:'',
        portfolio:'',
        tags:[],
        done:0,
        status:'Novo',
        packages:[],
        cpf:'',
        email:'',
        dob:''
      };
      editorData.first = nome || editorData.first;
      editorData.last = sobrenome || editorData.last;
      editorData.full = full || editorData.full;
      editorData.stars = START_STARS;
      lsSet(LS_EDITOR, editorData);
    }

    function renderTagsPreview(){
      if(!edTagsPreview) return;
      const raw = (edTags?.value||'').split(',').map(s=>s.trim()).filter(Boolean).slice(0,12);
      edTagsPreview.innerHTML = raw.map(t=>`<span class="tag blue">${escapeHtml(t)}</span>`).join('');
    }

    function paintEditor(){
      if(editorName) editorName.textContent = editorData?.first || 'Editor';
      if(editorFullName) editorFullName.textContent = editorData?.full || 'Editor';

      if(editorStars) editorStars.innerHTML = renderStarsHTML(editorData?.stars ?? START_STARS, MAX_STARS);
      if(edRatingTxt) edRatingTxt.textContent = String((editorData?.stars ?? START_STARS).toFixed(1));
      if(edStarsRow) edStarsRow.innerHTML = renderStarsHTML(editorData?.stars ?? START_STARS, MAX_STARS);

      if(edDone) edDone.textContent = String(editorData?.done || 0);
      if(edStatus) edStatus.textContent = editorData?.status || 'Novo';

      if(edAvailable){
        edAvailable.checked = !!editorData?.available;
        if(edAvailText) edAvailText.textContent = editorData?.available ? 'On' : 'Off';
      }

      if(edXp) edXp.value = editorData?.xp || 'iniciante';
      if(edWhats) edWhats.value = editorData?.whats || '';
      if(edBio) edBio.value = editorData?.bio || '';
      if(edSoft) edSoft.value = editorData?.soft || '';
      if(edPortfolio) edPortfolio.value = editorData?.portfolio || '';
      if(edTags) edTags.value = (editorData?.tags || []).join(', ');

      setAvatar(editorAvatarBox, editorData?.photo, (editorData?.full||'E')[0]);
      applyCoverToEl(document.getElementById('editorCover'), editorData?.cover);

      renderTagsPreview();
      renderEditorPackages();
      updatePkgCount();
      renderPublicPreview();
    }

    editorPhoto?.addEventListener('change', async (e)=>{
      const file = e.target.files?.[0];
      if(!file || !editorData) return;
      try{
        const data = await checkAndReadImage(file);
        editorData.photo = data;
      }catch(err){
        alert(String(err.message||err));
        e.target.value='';
        return;
      }
      lsSet(LS_EDITOR, editorData);
      paintEditor();
    });

    function removeEditorPhoto(){
      if(!editorData) return;
      editorData.photo = '';
      lsSet(LS_EDITOR, editorData);
      paintEditor();
    }

    edAvailable?.addEventListener('change', ()=>{
      if(!editorData) return;
      editorData.available = !!edAvailable.checked;
      if(edAvailText) edAvailText.textContent = editorData.available ? 'On' : 'Off';
      lsSet(LS_EDITOR, editorData);
      renderPublicPreview();
    });

    edTags?.addEventListener('input', renderTagsPreview);

    function saveEditorProfile(){
      if(!editorData) editorData = {first:'Editor', last:'', full:'Editor', stars:START_STARS, packages:[]};
      editorData.xp = edXp?.value || 'iniciante';
      editorData.whats = (edWhats?.value||'').trim();
      editorData.bio = (edBio?.value||'').trim();
      editorData.soft = (edSoft?.value||'').trim();
      editorData.portfolio = (edPortfolio?.value||'').trim();
      editorData.tags = (edTags?.value||'').split(',').map(s=>s.trim()).filter(Boolean).slice(0,12);
      editorData.stars = START_STARS;
      lsSet(LS_EDITOR, editorData);
      renderPublicPreview();
      alert('Perfil do editor salvo (demo).');
    }

    function resetEditor(){
      localStorage.removeItem(LS_EDITOR);
      editorData = null;
      alert('Reset feito. Reabra como Editor para criar de novo.');
      goBackStart();
    }



    // ===== Limites / validações rápidas =====
    const MAX_EDITOR_PACKAGES = 10;
    const MAX_WORK_PHOTOS = 30;
    const MAX_WORK_VIDEOS = 10;

    // clamp para números (ex: fotos/vídeos no personalizado)
    function clampInt(val, min, max){
      const n = parseInt(val||'0',10);
      if(isNaN(n)) return min;
      return Math.max(min, Math.min(max, n));
    }

    // ===== Pacotes do Editor (thumbs + só 5 + seta + atalhos) =====
    let showAllPackages = false;

    function toggleMorePackages(){
      showAllPackages = !showAllPackages;
      const btn = document.getElementById('toggleMorePkgs');
      if(btn) btn.textContent = showAllPackages ? 'Mostrar menos ↑' : 'Ver mais pacotes ↓';
      renderEditorPackages();
    }

    function updatePkgCount(){
      const count = (editorData?.packages || []).length;
      if(edPkgCount) edPkgCount.textContent = String(count);
      if(edPkgHint) edPkgHint.textContent = count ? 'Perfeito: você vai aparecer em pedidos compatíveis.' : 'Dica: selecione pelo menos 1 pacote para aparecer para clientes.';
    }

    function renderEditorPackages(){
      const wrap = document.getElementById('editorPackages');
      if(!wrap) return;

      const search = (edSearchPkg?.value || '').toLowerCase().trim();
      const quick = (edQuick?.value || 'all');

      if((search && !showAllPackages) || (quick !== 'all' && !showAllPackages)){
        showAllPackages = true;
        const btn = document.getElementById('toggleMorePkgs');
        if(btn) btn.textContent = 'Mostrar menos ↑';
      }

      wrap.innerHTML = '';

      packages.forEach((p, index) => {
        if(!showAllPackages && index >= 5) return;

        const text = `${p.name} ${p.items.join(' ')}`.toLowerCase();
        if(search && !text.includes(search)) return;

        const isVideo = p.name.toLowerCase().includes('vídeo') || p.name.toLowerCase().includes('short');
        const isFoto  = p.name.toLowerCase().includes('foto');
        const isMix   = p.name.toLowerCase().includes('combo') || p.name.toLowerCase().includes('mix') || (isVideo && isFoto);

        if(quick === 'video' && !isVideo) return;
        if(quick === 'foto' && !isFoto) return;
        if(quick === 'mix' && !isMix) return;
        if(quick === 'audio' && index < 8) return; // áudio a partir do pacote 9

        const checked = (editorData?.packages || []).includes(p.id);
        const audioExtras = (index >= 8) ? `<div class="pkg-meta">🎧 Ajustes de áudio incluídos</div>` : '';

        const el = document.createElement('label');
        el.className = 'pkg-item';
        el.innerHTML = `
          <div class="pkg-thumb"></div>
          <div>
            <div style="display:flex; gap:10px; align-items:flex-start;">
              <input type="checkbox" data-pkg="${p.id}" ${checked ? 'checked' : ''}>
              <div>
                <div class="pkg-title">${p.id}. ${escapeHtml(p.name)}</div>
                <div class="pkg-sub">Entrega: ${escapeHtml(p.eta)} • ${brl(p.price)}</div>
              </div>
            </div>
            <div class="pkg-meta">${p.items.map(x=>escapeHtml(x)).join(' • ')}</div>
            ${audioExtras}
          </div>
        `;
        wrap.appendChild(el);
      });

      wrap.querySelectorAll('input[type="checkbox"][data-pkg]').forEach(chk=>{
        chk.addEventListener('change', ()=>{
          const id = Number(chk.getAttribute('data-pkg'));
          if(!editorData) return;
          editorData.packages = editorData.packages || [];

          if(chk.checked){
            if(!editorData.packages.includes(id)) {
              if(editorData.packages.length >= MAX_EDITOR_PACKAGES){
                chk.checked = false;
                alert(`Limite atingido: no máximo ${MAX_EDITOR_PACKAGES} pacotes por editor.`);
                return;
              }
              editorData.packages.push(id);
            }
          }else{
            editorData.packages = editorData.packages.filter(x=>x!==id);
          }
          lsSet(LS_EDITOR, editorData);
          updatePkgCount();
          renderPublicPreview();
        });
      });
    }

    edSearchPkg?.addEventListener('input', renderEditorPackages);
    edQuick?.addEventListener('change', renderEditorPackages);

    function selectAllEditorPackages(flag){
      if(!editorData) return;
      editorData.packages = flag ? packages.slice(0, MAX_EDITOR_PACKAGES).map(p=>p.id) : [];
      lsSet(LS_EDITOR, editorData);
      renderEditorPackages();
      updatePkgCount();
      renderPublicPreview();
    }

    function saveEditorPackages(){
      lsSet(LS_EDITOR, editorData);
      alert('Pacotes salvos (demo).');
    }

    function renderPublicPreview(){
      if(!edPublicPreview) return;

      const tags = (editorData?.tags || []).slice(0,8);
      const pkgs = (editorData?.packages || []).slice(0,6);

      const pkgBadges = pkgs.map(id=>{
        const p = packages.find(x=>x.id===id);
        return p ? `<span class="badge pillBlue">${escapeHtml(p.name)}</span>` : '';
      }).join('');

      const tagBadges = tags.map(t=>`<span class="badge">${escapeHtml(t)}</span>`).join('');

      const statusBadge = editorData?.available
        ? `<span class="badge you">Disponível</span>`
        : `<span class="badge off">Indisponível</span>`;

      edPublicPreview.innerHTML = `
        <div class="eTop">
          <div style="display:flex; gap:10px; align-items:center;">
            <div class="avatar" style="width:48px;height:48px" id="pubAvatar"></div>
            <div>
              <div class="eName">${escapeHtml(editorData?.full || 'Editor')}</div>
              <div class="stars" style="margin-top:4px">${renderStarsHTML(editorData?.stars ?? START_STARS, MAX_STARS)}</div>
              <div class="eMeta">${escapeHtml(editorData?.xp || 'iniciante')} • ${escapeHtml(editorData?.soft || 'Softwares')}</div>
            </div>
          </div>
          <div style="text-align:right">
            ${statusBadge}
            <div class="eMeta" style="margin-top:6px">Pacotes: <strong>${(editorData?.packages||[]).length}</strong></div>
          </div>
        </div>

        <div class="eBio">${escapeHtml(editorData?.bio || 'Escreva uma bio curta e forte para aparecer melhor para clientes.')}</div>

        <div class="eBadges">${tagBadges || `<span class="badge off">Sem tags</span>`}</div>

        <div class="eBadges" style="margin-top:10px">${pkgBadges || `<span class="badge off">Sem pacotes selecionados</span>`}</div>

        <div class="hint" style="margin-top:10px">* Demo sem backend: informações ficam salvas no seu navegador.</div>
      `;

      const pubAvatar = document.getElementById('pubAvatar');
      setAvatar(pubAvatar, editorData?.photo, (editorData?.full||'E')[0]);
    }

    // ===== Tela “Escolher Editor” (demo) =====
    const DEMO_EDITORS = [
      { id:'d1', name:'Editor Neon',  xp:'avancado', tags:['Reels','TikTok','Áudio'], packages:[4,6,9,11,13,14,15], available:true,  stars:START_STARS },
      { id:'d2', name:'Editor Flux',  xp:'intermediario', tags:['Foto pro','Cor cine'], packages:[1,2,3,5,8,10,12,15], available:true, stars:START_STARS },
      { id:'d3', name:'Editor Pulse', xp:'intermediario', tags:['Motion','Legendas'], packages:[4,6,7,9,11,13,15], available:true, stars:START_STARS },
      { id:'d4', name:'Editor Vibe',  xp:'iniciante', tags:['Shorts','Cortes'], packages:[4,6,7,9], available:true, stars:START_STARS },
      { id:'d5', name:'Editor Clean', xp:'avancado', tags:['Áudio','Ruído','Voz'], packages:[9,11,13,14,15], available:true, stars:START_STARS },
    ];

    function getAllEditors(){
      const list = [];
      if(editorData){
        list.push({
          id:'you',
          name: editorData.full || 'Você',
          xp: editorData.xp || 'iniciante',
          tags: editorData.tags || [],
          packages: editorData.packages || [],
          available: !!editorData.available,
          photo: editorData.photo || '',
          stars: editorData.stars ?? START_STARS
        });
      }
      DEMO_EDITORS.forEach(e=> list.push({...e}));
      return list;
    }

    function isCompatible(editor, order){
      if(!editor.available) return false;
      // ✅ BOTS DEMO (testes): sempre compatíveis, para você sempre ver opções ao escolher um pacote
      if(String(editor.id||'').startsWith('d')) return true;
if(order?.kind === 'package') return (editor.packages || []).includes(order.packageId);

      const vids = Number(order?.videos||0);
      const fotos = Number(order?.fotos||0);

      if(vids > 0){
        return (editor.packages||[]).some(id => {
          const p = packages.find(x=>x.id===id);
          const n = (p?.name||'').toLowerCase();
          return n.includes('vídeo') || n.includes('short');
        });
      }
      if(fotos > 0){
        return (editor.packages||[]).some(id => {
          const p = packages.find(x=>x.id===id);
          const n = (p?.name||'').toLowerCase();
          return n.includes('foto');
        });
      }
      return (editor.packages||[]).length > 0;
    }

    function renderPickEditors(){
  const grid = document.getElementById('editorsGrid');
  if(!grid) return;

  const sort = document.getElementById('pickSort')?.value || 'best';
  const all = getAllEditors();

  let compatible = all.filter(e => isCompatible(e, currentOrder));

  // Filtra por nível escolhido (iniciante/intermediário/avançado)
  const _tier = normTier(currentOrder?.tier || PRICE_TIER || 'avancado');
  const tierRank = (t)=>({ iniciante:1, intermediario:2, avancado:3 }[normTier(t)] || 1);

  // Regra: mostra SOMENTE o nível escolhido
  // iniciante -> só iniciantes, intermediário -> só intermediários, avançado -> só avançados
  compatible = compatible.filter(e => normTier(e.xp) === _tier);

  if(sort === 'fast'){
    compatible.sort((a,b)=> tierRank(b.xp) - tierRank(a.xp));
  }else{
    compatible.sort((a,b)=>(Number(b.stars||START_STARS))-(Number(a.stars||START_STARS)));
  }

  grid.innerHTML = '';
  if(!compatible.length){
    grid.innerHTML = `<div class="card full" style="grid-column:1/-1">
      <h3>Nenhum editor compatível (demo)</h3>
      <p>Peça para um editor marcar os pacotes compatíveis e ficar “Disponível”.</p>
    </div>`;
    return;
  }

  window._pickEditorsById = window._pickEditorsById || {};
  compatible.forEach(e=>{
    window._pickEditorsById[e.id] = e;

    const you = e.id === 'you';
    const card = document.createElement('div');
    card.className = 'eCard';

    card.innerHTML = `
      <div class="eTop">
        <div style="display:flex; gap:10px; align-items:center;">
          <div class="avatar" style="width:46px;height:46px" id="pickAv_${e.id}">${escapeHtml(e.name[0])}</div>
          <div>
            <div class="eName">${escapeHtml(e.name)} ${you ? '• (Você)' : ''}</div>
            <div class="stars" style="margin-top:4px">${renderStarsHTML(e.stars ?? START_STARS, MAX_STARS)}</div>
            <div class="eMeta">${escapeHtml(e.xp)} • Pacotes: ${e.packages?.length||0}</div>
          </div>
        </div>
        <div><span class="badge ${e.available ? 'you' : 'off'}">${e.available ? 'Disponível' : 'Off'}</span></div>
      </div>

      <div class="eBio">${escapeHtml((e.tags||[]).slice(0,5).join(' • ') || 'Editor demo')}</div>
      <div class="eBadges">
        ${(e.tags||[]).slice(0,6).map(t=>`<span class="badge pillBlue">${escapeHtml(t)}</span>`).join('') || `<span class="badge off">Sem tags</span>`}
      </div>

      <div class="eActions" style="display:flex; gap:10px; flex-wrap:wrap; margin-top:12px">
        <button class="btn" type="button" data-action="select-editor" data-editor-id="${e.id}">Selecionar este editor</button>
        <button class="btn secondary" type="button" data-action="view-editor-profile" data-editor-id="${e.id}">Ver perfil do editor</button>
      </div>
      <div class="hint">* Demo: sem pagamento/entrega real ainda.</div>
    `;

    grid.appendChild(card);

    const av = document.getElementById(`pickAv_${e.id}`);
    if(av) setAvatar(av, e.photo || '', e.name[0]);
  });
}

// ✅ Perfil do editor na etapa "Escolha seu Editor"
window.openEditorProfileFromPick = function(id){
  try{
    const _id = String(id||'');

    // tenta pegar do cache do pick; fallback para lista geral
    const pickMap = window._pickEditorsById || {};
    const e = pickMap[_id] || (typeof getAllEditors==='function' ? (getAllEditors()||[]).find(x=>String(x.id)===_id) : null);

    // garante que o perfil consiga abrir mesmo fora do "Explorar"
    window.exploreEditorsById = window.exploreEditorsById || {};
    if(e) window.exploreEditorsById[_id] = e;

    // caso especial: perfil do "you" (você)
    if(_id==='you' && !window.exploreEditorsById[_id]){
      window.exploreEditorsById[_id] = {
        id:'you',
        name: (document.getElementById('editorName')?.textContent || 'Você'),
        xp: (window.editorData?.xp || 'avancado'),
        stars: (window.editorData?.stars ?? START_STARS),
        available: !!window.editorData?.available,
        photo: (window.editorData?.photo || ''),
        tags: (window.editorData?.tags || []),
        bio: (window.editorData?.bio || 'Perfil do editor (você).'),
        packages: (window.editorData?.packages || [])
      };
    }

    if(typeof openEditorProfile==='function'){
      openEditorProfile(_id);
    }
  }catch(err){
    console.error('openEditorProfileFromPick error:', err);
  }
};

document.getElementById('pickSort')?.addEventListener('change', renderPickEditors);

    function selectEditor(id){
      // Quando o cliente escolhe um editor, a gente FINALIZA o pedido e salva no Supabase.
      if(!currentOrder){
        alert('Antes de escolher o editor, selecione um pacote/pedido primeiro.');
        return;
      }
      let e = null;

      if(id === 'you'){
        if(!editorData?.available){
          alert('Seu perfil está como OFF. Ative “Disponível” no painel do editor.');
          return;
        }
        e = {
          id: (currentSession?.user?.id || 'you'),
          name: (editorData?.displayName || 'Você'),
          rating: (editorData?.rating || 5),
          tags: (editorData?.tags || [])
        };
      } else {
        e = (exploreEditorsById && exploreEditorsById[id]) || (exploreEditorsCache || []).find(x => x.id === id) || { id, name:'Editor', rating:5, tags:[] };
      }

      selectedEditorFromProcurar = e;
      currentOrder.editor = { id: e.id, name: e.name, rating: e.rating, tags: e.tags };

      // Abre confirmação do pedido em NOVA ABA (BETA)
      openConfirmTabFromCurrentOrder();
    }

    // Expor no escopo global para funcionar com onclick
    window.selectEditor = selectEditor;

    // =========================
    // ✅ Delegação de cliques (anti-bug)
    // Evita problemas de onclick não achar função / escopo / HTML gerado por template.
    // =========================
    document.addEventListener('click', (ev)=>{
      const btn = ev.target.closest('button, a, [role="button"]');
      if(!btn) return;
      const act = btn.getAttribute('data-action');
      if(!act) return;

      try{
        if(act === 'choose-package'){
          ev.preventDefault();
          const pid = parseInt(btn.getAttribute('data-package-id')||'0', 10);
          if(Number.isFinite(pid) && pid>0) choosePackage(pid);
          return;
        }
        if(act === 'select-editor'){
          ev.preventDefault();
          const eid = String(btn.getAttribute('data-editor-id')||'').trim();
          if(eid) selectEditor(eid);
          return;
        }
        if(act === 'view-editor-profile'){
          ev.preventDefault();
          const eid = String(btn.getAttribute('data-editor-id')||'').trim();
          if(eid) openEditorProfile(eid);
          return;
        }
      }catch(err){
        console.error('click handler error:', err);
        alert('Ops! Algo deu errado. Abra o Console (F12) para ver o erro.');
      }
    });

    // =========================
    // ✅ Flow BETA em nova aba: Confirmar Pedido -> Pagamento (demo) -> Chat
    // =========================
    const ORDER_STORE_KEY = 'kml_beta_orders_v1';

    function safeJsonParse(s, fallback){
      try{ return JSON.parse(s); }catch(e){ return fallback; }
    }
    function loadOrders(){
      return safeJsonParse(localStorage.getItem(ORDER_STORE_KEY) || '[]', []);
    }
    function saveOrders(list){
      localStorage.setItem(ORDER_STORE_KEY, JSON.stringify(list||[]));
    }
    function upsertOrder(order){
      if(!order) return;
      const list = loadOrders();
      const idx = list.findIndex(o => o && o.id === order.id);
      if(idx >= 0) list[idx] = order;
      else list.unshift(order);
      saveOrders(list);
      localStorage.setItem('kml_beta_order_'+order.id, JSON.stringify(order));
    }
    function getOrderById(id){
      const direct = localStorage.getItem('kml_beta_order_'+id);
      if(direct) return safeJsonParse(direct, null);
      const list = loadOrders();
      return list.find(o => o && o.id === id) || null;
    }
    function genOrderId(){
      return 'ord_' + Math.random().toString(16).slice(2) + Date.now().toString(16);
    }
    function normalizeOrderForStore(order){
      const o = JSON.parse(JSON.stringify(order||{}));
      if(!o.id) o.id = genOrderId();
      if(!o.status) o.status = 'AWAITING_PAYMENT';
      o.updatedAt = new Date().toISOString();
      if(!o.createdAt) o.createdAt = o.updatedAt;
      return o;
    }

    function encodeBetaPayload(obj){
      try{
        const json = JSON.stringify(obj || {});
        // base64url
        return btoa(unescape(encodeURIComponent(json)))
          .replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
      }catch(e){ return ''; }
    }
    function decodeBetaPayload(str){
      try{
        const s = String(str||'').replace(/-/g,'+').replace(/_/g,'/');
        const pad = s.length % 4 ? '='.repeat(4 - (s.length % 4)) : '';
        const json = decodeURIComponent(escape(atob(s + pad)));
        return JSON.parse(json);
      }catch(e){ return null; }
    }

    function openConfirmTabFromCurrentOrder(){
      try{
        if(!currentOrder) { alert('Selecione um pacote primeiro.'); return; }
        ensureOrderHasEditor();
        if(!currentOrder.editor){ alert('Selecione um editor para continuar.'); return; }

        // Monta um payload "preview" (não cria pedido ainda — evita bug e evita forçar pagamento na aba atual)
        const pkg = (currentOrder.kind !== 'custom') ? (packages || []).find(p => p.id === currentOrder.packageId) : null;
        const totalN = Number(currentOrder.total ?? (pkg ? pkg.price : 0) ?? 0);
        const payload = {
          v: 1,
          kind: currentOrder.kind || (pkg ? 'package' : 'custom'),
          packageId: currentOrder.packageId || (pkg ? pkg.id : null),
          title: currentOrder.title || (pkg ? pkg.name : 'Pacote Personalizado'),
          total: totalN,
          totalText: currentOrder.totalText || brl(totalN),
          eta: currentOrder.eta || (pkg ? pkg.eta : '—'),
          items: Array.isArray(currentOrder.items) ? currentOrder.items : (pkg ? (pkg.items||[]) : []),
          editor: currentOrder.editor,
          createdAt: new Date().toISOString()
        };

        const enc = encodeBetaPayload(payload);
        // Em vez de abrir nova aba, mostramos a confirmação AQUI MESMO (uma única aba)
        location.hash = '#beta_preview=' + encodeURIComponent(enc);
        try{ handleBetaHashRoutes(); }catch(e){}
        // Não resetamos o fluxo automaticamente; o usuário pode fechar e escolher outro pacote/editor.
      }catch(err){
        console.error('openConfirmTabFromCurrentOrder error:', err);
        alert('Erro ao abrir confirmação. Veja o Console (F12).');
      }
    }

    function renderBetaTabUI(order, step){
      // step: 'confirm' | 'pay' | 'done'
      let root = document.getElementById('betaTabRoot');
      if(!root){
        root = document.createElement('div');
        root.id = 'betaTabRoot';
        document.body.appendChild(root);
      }
      document.body.classList.add('betaTabMode');

      // Resolve itens do pacote (evita ReferenceError e evita aba vazia)
      let items = [];
      try{
        if(Array.isArray(order?.items)) items = order.items.slice();
        if(!items.length && order?.packageId){
          const pkg = (packages||[]).find(p => p.id === order.packageId);
          if(pkg && Array.isArray(pkg.items)) items = pkg.items.slice();
        }
      }catch(e){ items = []; }

      const title = escapeHtml(order.title || 'Pedido');
      const totalText = escapeHtml(order.totalText || brl(order.total||0));
      const eta = escapeHtml(order.eta || '—');
      const editorName = escapeHtml(order.editor?.name || 'Editor');
      const rating = escapeHtml(String(order.editor?.rating ?? START_STARS));
      const statusLabel = (order.status === 'PAID') ? 'Pago'
                        : (order.status === 'AWAITING_PAYMENT') ? 'Aguardando pagamento'
                        : (order.status === 'DRAFT') ? 'Rascunho'
                        : (order.status === 'PREVIEW') ? 'Prévia'
                        : escapeHtml(String(order.status||'—'));

      const itemsBlock = items.length ? `
        <div class="pill" style="margin-top:10px">
          <b>O que vem:</b>
          <div style="margin-top:6px">
            <ul style="margin:0; padding-left:18px">
              ${items.map(i => `<li>${escapeHtml(i)}</li>`).join('')}
            </ul>
          </div>
        </div>
      ` : '';

      const tags = Array.isArray(order.editor?.tags) ? order.editor.tags : [];
      const tagsBlock = tags.length ? `
        <div style="display:flex; flex-wrap:wrap; gap:8px; margin-top:8px">
          ${tags.map(t => `<span class="pill" style="padding:6px 10px">${escapeHtml(t)}</span>`).join('')}
        </div>
      ` : `<div class="hint" style="margin-top:8px">Tags: —</div>`;

      function ensurePersisted(status){
        // Cria um pedido real só quando o usuário clicar em pagar/chat
        try{
          if(order.id){
            const existing = getOrderById(order.id);
            if(existing) return existing;
          }
        }catch(e){}
        const stored = normalizeOrderForStore({
          id: null,
          kind: order.kind,
          packageId: order.packageId,
          title: order.title || 'Pedido',
          total: Number(order.total||0),
          totalText: order.totalText || brl(Number(order.total||0)),
          eta: order.eta || '—',
          items: items,
          editor: order.editor,
          status: status || 'DRAFT'
        });
        order.id = stored.id;
        order.status = stored.status;
        order.items = stored.items || items;
        upsertOrder(stored);
        return stored;
      }

      function openChatForOrder(o){
        try{
          chatCtx = {
            peerId: o.editor?.id || '',
            peerName: o.editor?.name || 'Editor',
            peerWhats: o.editor?.whats || '',
            key: 'chat_order_' + String(o.id||'')
          };
          if(chatTitle) chatTitle.textContent = `Chat do pedido • ${o.editor?.name || 'Editor'}`;
          renderChat();
          if(chatOverlay){
            chatOverlay.classList.remove('closing');
            chatModal?.classList.remove('closing');
            chatOverlay.classList.add('show');
            chatOverlay.style.display = 'flex';
          }
        }catch(e){
          console.error('openChatForOrder error', e);
          alert('Não consegui abrir o chat. Veja o Console (F12).');
        }
      }

      let inner = `
        <div class="overlay show" style="display:flex">
          <div class="modal" style="max-width:860px;width:min(860px,100%);">
            <div class="modalHead">
              <div>
                <div style="font-weight:900;font-size:1.2rem">Karameloo • Beta</div>
                <div class="hint">Confirmação, pagamento e chat (demo)</div>
              </div>
              <button class="xBtn" id="betaTabCloseBtn" aria-label="Fechar">✕</button>
            </div>

            <div class="card" style="padding:14px;border-radius:16px">
              <div class="pill" style="display:flex;gap:10px;flex-wrap:wrap;justify-content:space-between">
                <span><b>Status:</b> ${statusLabel}</span>
                <span><b>Total:</b> ${totalText}</span>
                <span><b>Entrega:</b> ${eta}</span>
              </div>

              <div style="display:grid; grid-template-columns: 1.2fr .8fr; gap:12px; margin-top:12px">
                <div class="pill" style="padding:12px 14px">
                  <div style="font-weight:900">Resumo do pedido</div>
                  <div style="margin-top:6px"><b>Serviço:</b> ${title}</div>
                  ${itemsBlock || `<div class="hint" style="margin-top:8px">Itens do pacote: —</div>`}
                </div>

                <div class="pill" style="padding:12px 14px">
                  <div style="font-weight:900">Sobre o editor</div>
                  <div style="margin-top:6px"><b>Nome:</b> ${editorName}</div>
                  <div style="margin-top:6px"><b>Avaliação:</b> ${rating}/10</div>
                  ${tagsBlock}
                </div>
              </div>
      `;

      if(step === 'confirm'){
        inner += `
          <h3 style="margin:14px 0 8px 0">Confirmar</h3>
          <p class="hint" style="margin-top:0">Agora escolha: pagar agora ou falar com o editor.</p>

          <div style="display:flex; gap:10px; flex-wrap:wrap; margin-top:12px">
            <button class="btn" type="button" id="betaPayNowBtn">Pagar agora</button>
            <button class="btn secondary" type="button" id="betaTalkBtn">Falar com o editor</button>
            <button class="btn secondary" type="button" id="betaOpenProfileBtn">Ver perfil do editor</button>
          </div>
        `;
      } else if(step === 'pay'){
        inner += `
          <h3 style="margin:14px 0 8px 0">Pagamento • PIX (demo)</h3>
          <p class="hint" style="margin-top:0">No beta o pagamento é simulado para testar o fluxo.</p>

          <div class="card" style="background:rgba(0,0,0,.25);border-radius:14px;padding:14px;margin-top:10px">
            <div style="font-weight:800">Chave PIX (demo)</div>
            <div style="margin-top:6px;word-break:break-all;opacity:.95">karameloo@pix.demo</div>
            <div class="hint" style="margin-top:8px">Depois de “pagar” (simulado), clique em confirmar.</div>
          </div>

          <div style="display:flex; gap:10px; flex-wrap:wrap; margin-top:14px">
            <button class="btn" type="button" id="betaPaidBtn">Já paguei (confirmar)</button>
            <button class="btn secondary" type="button" id="betaBackConfirmBtn">Voltar</button>
          </div>
        `;
      } else {
        inner += `
          <h3 style="margin:14px 0 8px 0">Pagamento confirmado ✅</h3>
          <p class="hint" style="margin-top:0">Agora você já pode falar com o editor.</p>

          <div style="display:flex; gap:10px; flex-wrap:wrap; margin-top:14px">
            <button class="btn" type="button" id="betaOpenChatBtn">Abrir chat</button>
            <button class="btn secondary" type="button" id="betaViewOrderBtn">Ver resumo</button>
          </div>
        `;
      }

      inner += `
            </div>
          </div>
        </div>
      `;

      root.innerHTML = inner;

      // handlers
      const closeBtn = document.getElementById('betaTabCloseBtn');
      const exitBeta = ()=>{
        try{
          document.body.classList.remove('betaTabMode');
          const r = document.getElementById('betaTabRoot');
          if(r) r.innerHTML = '';
          const base = window.location.href.split('#')[0];
          history.replaceState(null, '', base);
        }catch(e){}
      };
      if(closeBtn) closeBtn.onclick = exitBeta;

      if(step === 'confirm'){
        const payNow = document.getElementById('betaPayNowBtn');
        const talk = document.getElementById('betaTalkBtn');
        const openProfile = document.getElementById('betaOpenProfileBtn');

        if(payNow) payNow.onclick = ()=>{
          const stored = ensurePersisted('AWAITING_PAYMENT');
          location.hash = '#beta_pay=' + encodeURIComponent(stored.id);
        };

        if(talk) talk.onclick = ()=>{
          const stored = ensurePersisted('DRAFT');
          openChatForOrder(stored);
        };

        if(openProfile) openProfile.onclick = ()=>{
          try{
            // usa o perfil do editor (se existir na base em memória), senão só não faz nada
            openEditorProfile(order.editor?.id);
          }catch(e){}
        };
      }

      if(step === 'pay'){
        const paid = document.getElementById('betaPaidBtn');
        const back = document.getElementById('betaBackConfirmBtn');
        if(back){
          back.onclick = ()=>{
            // volta para o resumo/confirm do pedido
            if(order.id) location.hash = '#beta_confirm=' + encodeURIComponent(order.id);
            else location.hash = '#beta_preview=' + encodeURIComponent(encodeBetaPayload(order));
          };
        }
        if(paid) paid.onclick = ()=>{
          const stored = ensurePersisted('AWAITING_PAYMENT');
          stored.status = 'PAID';
          stored.paidAt = new Date().toISOString();
          upsertOrder(stored);
          location.hash = '#beta_done=' + encodeURIComponent(stored.id);
        };
      }

      if(step === 'done'){
        const openChatBtn = document.getElementById('betaOpenChatBtn');
        const viewOrderBtn = document.getElementById('betaViewOrderBtn');
        if(openChatBtn) openChatBtn.onclick = ()=>{
          const stored = ensurePersisted(order.status || 'PAID');
          openChatForOrder(stored);
        };
        if(viewOrderBtn) viewOrderBtn.onclick = ()=>{
          if(order.id) location.hash = '#beta_confirm=' + encodeURIComponent(order.id);
        };
      }
    }

    function handleBetaHashRoutes(){
      const h = String(location.hash||'');

      // Preview (abre ao selecionar o editor) — não depende de localStorage (evita aba vazia no file://)
      const mPrev = h.match(/^#beta_preview=([\w%.-]+)/);
      if(mPrev){
        const enc = decodeURIComponent(mPrev[1]||'');
        const p = decodeBetaPayload(enc) || {};
        const order = {
          id: null,
          kind: p.kind || 'package',
          packageId: p.packageId || null,
          title: p.title || 'Pedido',
          total: Number(p.total||0),
          totalText: p.totalText || brl(Number(p.total||0)),
          eta: p.eta || '—',
          items: Array.isArray(p.items) ? p.items : [],
          editor: p.editor || { id:'', name:'—', rating:START_STARS, tags:[] },
          status: 'PREVIEW',
          _preview: true
        };
        renderBetaTabUI(order, 'confirm');
        return true;
      }

      const match = h.match(/^#beta_(confirm|pay|done)=([\w%.-]+)/);
      if(!match) return false;
      const step = match[1];
      const id = decodeURIComponent(match[2]||'');
      let order = null;
      try{ order = getOrderById(id); }catch(e){ order = null; }
      if(!order){
        renderBetaTabUI({ id, title:'Pedido não encontrado', total:0, totalText: brl(0), eta:'—', items:[], editor:{name:'—',rating:START_STARS,tags:[]} }, 'confirm');
        return true;
      }
      if(step === 'confirm') renderBetaTabUI(order, 'confirm');
      if(step === 'pay') renderBetaTabUI(order, 'pay');
      if(step === 'done') renderBetaTabUI(order, 'done');
      return true;
    }

    window.addEventListener('hashchange', ()=>{ try{ handleBetaHashRoutes(); }catch(e){} });

    // Chama no load também (para quando abrir a nova aba)
    setTimeout(()=>{ try{ handleBetaHashRoutes(); }catch(e){} }, 0);


    // ===== Cadastro (modal) =====
    function buildClientDefaults(){
      return {
        first:'Cliente', last:'', full:'Cliente',
        stars: START_STARS,
        photo:'',
        cover:{preset:'none', img:''},
        whats:'', city:'', niche:'', mainPlatform:'instagram', about:'',
        cpf:'', email:'', dob:''
      };
    }
    function buildEditorDefaults(){
      return {
        first:'Editor', last:'', full:'Editor',
        stars: START_STARS,
        photo:'',
        cover:{preset:'none', img:''},
        available:false,
        xp:'iniciante', whats:'', bio:'', soft:'', portfolio:'', tags:[],
        done:0, status:'Novo', packages:[],
        cpf:'', email:'', dob:''
      };
    }

    function saveAccount(kind, account){
      const acc = getAccounts();
      acc[kind] = acc[kind] || {};
      acc[kind][normEmail(account.email)] = account;
      setAccounts(acc);
    }

    function loadAccount(kind, email){
      const acc = getAccounts();
      return acc?.[kind]?.[normEmail(email)] || null;
    }

    function applyAccountToSession(kind, account){
      if(kind === 'client'){
        clientData = account.profile;
        lsSet(LS_CLIENT, clientData);
        paintClientProfile();
        paintClientTop();
      }else{
        editorData = account.profile;
        lsSet(LS_EDITOR, editorData);
        paintEditor();
      }
    }

    btnCadastrar?.addEventListener('click', async ()=>{
      const nome=(inNome?.value||'').trim();
      const sobrenome=(inSobrenome?.value||'').trim();
      const dob=(inData?.value||'').trim();
      const cpfRaw=(inCPF?.value||'').trim();
      const cpfD=cpfDigits(cpfRaw);
      const email=(inEmail?.value||'').trim();
      const senha=(inSenha?.value||'').trim();
      const senha2=(inSenha2?.value||'').trim();

      if(!senha2){ alert('Confirme sua senha.'); return; }
      if(senha2 !== senha){ alert('As senhas não conferem. Confira e tente novamente.'); return; }

      // QUICK ADMIN (demo): digite apenas "adm" em Nome OU Sobrenome para entrar no painel ADM
      const __admQuick = (/^adm$/i.test(nome) || /^adm$/i.test(sobrenome) || /^admin$/i.test(nome) || /^admin$/i.test(sobrenome));
      if(__admQuick){
        showLoading('Abrindo painel ADM…','Entrando como administrador');
        try{
          localStorage.setItem("karameloo_user_name","ADM");
          localStorage.setItem("karameloo_user_role","admin");
          sessionStorage.setItem("karameloo_force_admin","1");
        }catch(e){}
        try{ if(typeof closeCadastro === "function") closeCadastro(); }catch(e){}
        try{
          if(typeof window.openAdminDashboard === "function"){
            window.openAdminDashboard();
          }else if(typeof boot === "function"){
            boot();
          }
        }catch(e){}
        try{ window.scrollTo({top:0, behavior:"smooth"}); }catch(e){}
        return;
      }

      // Se Supabase estiver ativo, cadastro real (aparece em Authentication → Users)
      if(SUPABASE_ENABLED){
        try{
          showLoading('Entrando…','Verificando sua conta');
          // validações básicas (mantém as mesmas do modo local)
          if(!nome||!sobrenome){ alert('Preencha Nome e Sobrenome.'); hideLoading(); return; }
          if(!dob){ alert('Preencha a data de nascimento.'); hideLoading(); return; }
          if(!email){ alert('Preencha o email.'); hideLoading(); return; }
          if(!senha || senha.length < 6){ alert('Crie uma senha (mínimo 6 caracteres).'); hideLoading(); return; }
          if(!isValidCPF(cpfD)){ alert('CPF inválido.'); hideLoading(); return; }
          if(role === 'editor'){
            const age = calcAge(dob);
            if(!(age >= 18)){
              alert('Para ser Editor/Vendedor, você precisa ter 18+ (regra do projeto).');
              hideLoading();
              return;
            }
          }

          showLoading('Criando conta…','Validando e salvando');


          const eKey = normEmail(email);


          const r = await supaRegisterFlow({ nome, sobrenome, dob, cpfD, email: eKey, senha, roleUi: role });
          if(!r?.ok){ hideLoading(); return; }

          closeCadastro();

          // Mantém sua UI atual (sem reescrever tudo): salva um perfil local para navegar nas telas
          if(role==='cliente'){
            ensureClientData(nome, sobrenome);
            clientData.cpf = cpfD;
            clientData.email = eKey;
            clientData.dob = dob;
            clientData.stars = START_STARS;
            lsSet(LS_CLIENT, clientData);
            paintClientProfile();
            paintClientTop();
            setActiveSession('cliente');
            goProcurar(true);
            setTimeout(runPostLoginIntent, 80);
          hideLoading();
      }else{
            ensureEditorData(nome, sobrenome);
            editorData.cpf = cpfD;
            editorData.email = eKey;
            editorData.dob = dob;
            editorData.stars = START_STARS;
            lsSet(LS_EDITOR, editorData);
            paintEditor();
            setActiveSession('editor');
            showScreen(screenEditor);
        hideLoading();
      }
          hideLoading();
          hideLoading();

          return;
        }catch(err){
          hideLoading();
          const msg = (err && err.message) ? err.message : String(err);
          // Mensagens comuns
          if(/User already registered/i.test(msg) || /already registered/i.test(msg)){
            alert('Esse email já está cadastrado. Use "Já tenho conta" para entrar.');
          }else if(/duplicate key value/i.test(msg) || /cpf_hash/i.test(msg)){
            alert('Esse CPF já está cadastrado.');
          }else{
            alert('Erro no cadastro: ' + msg);
          }
          return;
        }
      }


      // Atalho ADM (testes)
      if(String(nome).trim().toLowerCase() === 'adm'){
        closeCadastro();
        if(role==='cliente'){
          clientData = buildClientDefaults();
          clientData.first = 'ADM';
          clientData.full = 'ADM';
          lsSet(LS_CLIENT, clientData);
          paintClientProfile();
          setActiveSession('cliente');
        goProcurar(true);
        setTimeout(runPostLoginIntent, 80);
        hideLoading();
      }else{
          editorData = buildEditorDefaults();
          editorData.first = 'ADM';
          editorData.full = 'ADM';
          lsSet(LS_EDITOR, editorData);
          paintEditor();
          setActiveSession('editor');
          showScreen(screenEditor);
        }
        hideLoading();
        return;
      }

      if(!nome||!sobrenome){ alert('Preencha Nome e Sobrenome.'); hideLoading(); return; }
      if(!dob){ alert('Preencha a data de nascimento.'); hideLoading(); return; }
      if(!email){ alert('Preencha o email.'); hideLoading(); return; }
      if(!senha || senha.length < 4){ alert('Crie uma senha (mínimo 4 caracteres).'); return; }
      if(!isValidCPF(cpfD)){ alert('CPF inválido.'); hideLoading(); return; }

      if(role === 'editor'){
        const age = calcAge(dob);
        if(!(age >= 18)){
          alert('Para ser Editor precisa ter 18+.\nMenores: somente no futuro com autorização dos pais e foto do RG (backend).');
          return;
        }
      }

      const kind = roleKey(); // client | editor
      const acc = getAccounts();
      acc[kind] = acc[kind] || {};

      const eKey = normEmail(email);
      if(acc[kind][eKey]){
        alert('Esse email já está cadastrado. Clique em "Já tenho conta" para entrar.');
        return;
      }

      const existingEmail = findEmailByCPF(kind, cpfD);
      if(existingEmail){
        alert('Esse CPF já está cadastrado nessa modalidade de conta.\nUse "Já tenho conta" para entrar.');
        return;
      }
      showLoading('Criando conta…','Preparando seu perfil');
      closeCadastro();

      if(role==='cliente'){
        ensureClientData(nome, sobrenome);
        clientData.cpf = cpfD;
        clientData.email = eKey;
        clientData.dob = dob;
        clientData.stars = START_STARS;
        lsSet(LS_CLIENT, clientData);

        saveAccount('client', { email:eKey, pass:senha, cpf:cpfD, profile: clientData });

        paintClientProfile();
        setActiveSession('cliente');
        goProcurar(true);
        setTimeout(runPostLoginIntent, 80);
        hideLoading();
      }else{
        ensureEditorData(nome, sobrenome);
        editorData.cpf = cpfD;
        editorData.email = eKey;
        editorData.dob = dob;
        editorData.stars = START_STARS;
        lsSet(LS_EDITOR, editorData);

        saveAccount('editor', { email:eKey, pass:senha, cpf:cpfD, profile: editorData });

        paintEditor();
        setActiveSession('editor');
        showScreen(screenEditor);
        hideLoading();
      }
    });

    btnLogin?.addEventListener('click', async ()=>{
      const email=(loginEmail?.value||'').trim();
      const senha=(loginSenha?.value||'').trim();

      // Se Supabase estiver ativo, login real
      if(SUPABASE_ENABLED){
        try{
          const eKey = normEmail(email);
          const r = await supaLoginFlow({ email: eKey, senha });

          // Se não tiver profile ainda, cria um mínimo com base na tela (cliente/editor)
          const roleValue = (role === 'cliente') ? 'client' : 'editor';
          const displayName = r?.profile?.display_name || (eKey.split('@')[0] || 'Usuário');
          if(!r?.profile){
            await supaEnsureProfileAndCpf({ userId: r.userId, displayName, roleValue, cpfDigitsOnly: null });
          }

          closeCadastro();

          // Mantém a navegação atual com perfil local (até a gente integrar tudo com banco)
          if(role === 'cliente'){
            const parts = String(displayName).split(' ');
            ensureClientData(parts[0] || displayName, parts.slice(1).join(' ') || '');
            clientData.email = eKey;
            clientData.stars = START_STARS;
            lsSet(LS_CLIENT, clientData);
            paintClientProfile();
            paintClientTop();
            setActiveSession('cliente');
            goProcurar(true);
            setTimeout(runPostLoginIntent, 80);
          }else{
            const parts = String(displayName).split(' ');
            ensureEditorData(parts[0] || displayName, parts.slice(1).join(' ') || '');
            editorData.email = eKey;
            editorData.stars = START_STARS;
            lsSet(LS_EDITOR, editorData);
            paintEditor();
            setActiveSession('editor');
            showScreen(screenEditor);
          }
        hideLoading();
        return;
        }catch(err){
          hideLoading();
          const msg = (err && err.message) ? err.message : String(err);
          alert('Erro no login: ' + msg);
          return;
        }
      }

      if(!email || !senha){
        alert('Preencha email e senha.');
        return;
      }

      showLoading('Entrando…','Carregando sua área');

      // Atalho ADM (testes): se o usuário digitar "adm" no email ou na senha,
      // pulamos a validação de contas e entramos diretamente como ADM.
      if(String(email).trim().toLowerCase() === 'adm' || String(senha).trim().toLowerCase() === 'adm'){
        closeCadastro();
        if(role === 'cliente'){
          // cria perfil de cliente ADM e navega para o perfil do cliente
          clientData = buildClientDefaults();
          clientData.first = 'ADM';
          clientData.full  = 'ADM';
          lsSet(LS_CLIENT, clientData);
          paintClientProfile();
          paintClientTop();
          goProcurar(true);
        }else{
          // cria perfil de editor ADM e navega para o dashboard do editor
          editorData = buildEditorDefaults();
          editorData.first = 'ADM';
          editorData.full  = 'ADM';
          lsSet(LS_EDITOR, editorData);
          paintEditor();
          setActiveSession('editor');
          showScreen(screenEditor);
        }
        return;
      }

      const kind = roleKey();
      const account = loadAccount(kind, email);
      if(!account || account.pass !== senha){
        hideLoading();
        alert('Email ou senha incorretos (demo).');
        return;
      }

      closeCadastro();
      applyAccountToSession(kind, account);
      if(role==='cliente') setActiveSession('cliente');
      else setActiveSession('editor');

      if(role==='cliente') goProcurar(true);
      else showScreen(screenEditor);
    hideLoading();
    });

    // ===== IA Karameloo (demo local — Cliente + Editor + novos usuários) =====
    const aiFab = document.getElementById('aiFab');
    const aiPanel = document.getElementById('aiPanel');
    const aiClose = document.getElementById('aiClose');
    const aiMsgs = document.getElementById('aiMsgs');
    const aiForm = document.getElementById('aiForm');
    const aiInput = document.getElementById('aiInput');
    const aiChips = document.getElementById('aiChips');

    const AI_INTRO_KEY = 'karamelo_ai_intro_v1';

    function aiAdd(text, me=false){
      if(!aiMsgs) return;
      const div = document.createElement('div');
      div.className = 'aiMsg' + (me ? ' me' : '');
      div.innerHTML = escapeHtml(String(text||'')).replace(/\n/g,'<br>');
      aiMsgs.appendChild(div);
      aiMsgs.scrollTop = aiMsgs.scrollHeight;
    }

    function aiGetScreen(){
      if(screenEditor?.classList.contains('show')) return 'editor';
      if(screenClientProfile?.classList.contains('show')) return 'cliente_perfil';
      if(screenClient?.classList.contains('show')) return 'cliente';
      if(screenPickEditor?.classList.contains('show')) return 'escolha_editor';
      return 'start';
    }

    function aiSuggestPackages(){
      // dica simples baseada em quantidade (se o usuário estiver no personalizado)
      const fotos = parseInt(document.getElementById('custFotos')?.value || '0', 10) || 0;
      const vids  = parseInt(document.getElementById('custVideos')?.value || '0', 10) || 0;
      if(fotos === 0 && vids === 0){
        return 'Para começar rápido: “Starter Foto” (1 foto) ou “Vídeo Short 15s”.\nSe você já sabe quantas fotos/vídeos quer, use o Personalizado e eu te ajudo a montar.';
      }
      if(vids > 0 && fotos === 0){
        return `Você colocou ${vids} vídeo(s). Dica: escolha o tipo (15s/45s/60s) e marque extras como Legendas/Cor cine.\nSe quiser rapidez, deixe sem extras e sem Urgente.`;
      }
      if(fotos > 0 && vids === 0){
        return `Você colocou ${fotos} foto(s). Dica: marque Retoque avançado se for produto/beleza.\nSe for só ajuste, deixe sem extras para ficar mais barato.`;
      }
      return `Você colocou ${fotos} foto(s) e ${vids} vídeo(s). Dica: use “Combo Social” se quer algo pronto, ou finalize no Personalizado com extras só no que precisa.`;
    }

    function aiHelp(topic){
      const where = aiGetScreen();
      if(topic === 'novo'){
        aiAdd('Bem-vindo(a) à Karameloo! ✨\n\n• Se você quer comprar edição: clique em “Sou Cliente” → Criar conta → preencha o perfil → escolha um pacote ou o Personalizado.\n• Se você quer trabalhar: clique em “Quero Trabalhar” → Criar conta → complete o perfil → selecione até 10 pacotes → ative “Disponível”.');
        return;
      }
      if(topic === 'cliente'){
        aiAdd('Modo Cliente ✅\n\n1) Crie sua conta e complete o perfil.\n2) Escolha um pacote pronto ou monte o Personalizado.\n3) Depois, selecione um editor compatível (demo).\n\nSe quiser, me diga “quantas fotos e vídeos” e eu sugiro o melhor caminho.');
        if(where === 'cliente' || where === 'cliente_perfil') aiAdd('Dica: no Personalizado, marque só os extras essenciais (ex: Legendas + Cor cine) para não encarecer demais.');
        return;
      }
      if(topic === 'editor'){
        aiAdd('Modo Editor ✅\n\n1) Complete seu perfil (bio curta + softwares + tags).\n2) Selecione os pacotes que você aceita (limite: 10).\n3) Ative “Disponível” para aparecer para clientes.\n4) Portfólio: até 30 fotos e 10 vídeos (demo).');
        aiAdd('Sugestão de bio: “Cortes rápidos + cor cinematográfica + áudio limpo. Reels/TikTok. Entrega rápida.”');
        return;
      }
      if(topic === 'pacotes'){
        aiAdd(aiSuggestPackages());
        return;
      }
      if(topic === 'bio'){
        aiAdd('Bio/Tags (Editor) ✍️\n\nBio curta (1–2 linhas) + 4–8 tags.\nExemplo tags: Reels, TikTok, Legendas, Cor cine, Áudio, Foto pro.\n\nSe você me disser seu estilo, eu monto uma bio pronta.');
        return;
      }
    }

    function aiOpen(){
      if(!aiPanel) return;
      aiPanel.classList.add('show');
      aiPanel.classList.remove('pop'); void aiPanel.offsetHeight; aiPanel.classList.add('pop');
      aiPanel.setAttribute('aria-hidden','false');
      if(aiMsgs && aiMsgs.childElementCount === 0){
        aiHelp('novo');
      }
      document.getElementById('aiInput')?.focus();
    }
    function aiClosePanel(){
      aiPanel?.classList.remove('show');
      aiPanel?.setAttribute('aria-hidden','true');
    }

    function aiReply(userText){
      const t = String(userText||'').toLowerCase();
      if(t.includes('primeiro') || t.includes('começar') || t.includes('novo')) return aiHelp('novo');
      if(t.includes('cliente') || t.includes('comprar') || t.includes('pedido')) return aiHelp('cliente');
      if(t.includes('editor') || t.includes('trabalhar') || t.includes('portfólio') || t.includes('portfolio')) return aiHelp('editor');
      if(t.includes('pacote') || t.includes('preço') || t.includes('personalizado') || t.includes('fotos') || t.includes('vídeos') || t.includes('videos')) return aiHelp('pacotes');
      if(t.includes('bio') || t.includes('tag')) return aiHelp('bio');
      aiAdd('Entendi! Me diga se você é Cliente ou Editor e o que você quer fazer agora (ex: “quero 3 vídeos de 15s com legenda”).');
    }

    aiFab?.addEventListener('click', ()=>{
      try{ aiFab.classList.remove('kick'); void aiFab.offsetHeight; aiFab.classList.add('kick'); }catch(e){}
      if(aiPanel?.classList.contains('show')) aiClosePanel();
      else aiOpen();
    });
    aiClose?.addEventListener('click', aiClosePanel);

    aiChips?.addEventListener('click', (e)=>{
      const btn = e.target?.closest('button[data-ai]');
      if(!btn) return;
      aiHelp(String(btn.getAttribute('data-ai')||''));
    });

    aiForm?.addEventListener('submit', (e)=>{
      e.preventDefault();
      const msg = String(aiInput?.value || '').trim();
      if(!msg) return;
      aiAdd(msg, true);
      aiInput.value = '';
      setTimeout(()=> aiReply(msg), 120);
    });

    // ===== Init =====
    window.addEventListener('DOMContentLoaded', ()=>{
      // Portfolio inputs
      const edWorkPhotos = document.getElementById('edWorkPhotos');
      const edWorkVideos = document.getElementById('edWorkVideos');
      edWorkPhotos?.addEventListener('change', (e)=>{ addFilesToWork('photo', e.target.files); });
      edWorkVideos?.addEventListener('change', (e)=>{ addFilesToWork('video', e.target.files); });
      updateWorkUI();

      // Clamp inputs numéricos (evita digitar infinito)
      const cf = document.getElementById('custFotos');
      const cv = document.getElementById('custVideos');
      cf?.addEventListener('input', ()=>{ cf.value = String(clampInt(cf.value,0,999)); });
      cv?.addEventListener('input', ()=>{ cv.value = String(clampInt(cv.value,0,999)); });

      // WhatsApp: só números + ()- e espaço
      const telFix = (el)=>{
        if(!el) return;
        el.addEventListener('input', ()=>{
          el.value = String(el.value||'').replace(/[^0-9()\-\s+]/g,'').slice(0,15);
        });
      };
      telFix(document.getElementById('clWhats'));
      telFix(document.getElementById('edWhats'));

      clientData = lsGet(LS_CLIENT, clientData);
      editorData = lsGet(LS_EDITOR, editorData);

      // pinta estado se já tiver algo salvo
      if(clientData){ paintClientProfile(); paintClientTop(); }
      if(editorData){ paintEditor(); }

      calcCustom();

      // Restaura a última tela/seleções (beta) para não voltar do início ao recarregar
      try{ setTimeout(()=>{ uiRestore(); }, 60); }catch(e){}

      // IA: abre automaticamente 1x para quem nunca entrou (somente se não estiver com modal aberto)
      try{
        if(!localStorage.getItem(AI_INTRO_KEY)){
          setTimeout(()=>{
            if(!overlay?.classList.contains('show')) aiOpen();
            localStorage.setItem(AI_INTRO_KEY,'1');
          }, 700);
        }
      }catch(e){}
    });

/* === extracted script block separator === */

(() => {
  // ---------- Background stars generation (dawn but still stars) ----------
  const bgStars = document.querySelector(".bgfx-bg-stars");
  if(bgStars){
    const rand = mulberry32(1337);
    let s = "";
    for(let i=0;i<18;i++){
      const x = Math.floor(rand()*1200);
      const y = Math.floor(rand()*360);
      const r = [0.8,1.0,1.2,1.6,2.2][Math.floor(rand()*5)];
      const o = (0.22 + rand()*0.65).toFixed(3);
      s += `<circle cx="${x}" cy="${y}" r="${r}" fill="rgba(255,255,255,${o})"/>`;
    }
    bgStars.innerHTML = s;
  }

  function mulberry32(a){return function(){let t=a+=0x6D2B79F5;t=Math.imul(t^t>>>15,t|1);t^=t+Math.imul(t^t>>>7,t|61);return ((t^t>>>14)>>>0)/4294967296}}

  // ---------- Constellation glow follows pointer ----------
  const svg = document.querySelector(".bgfx-constellations");
  const glow = document.querySelector(".bgfx-star-glow");
  let raf=0, px=0, py=0;
  if(svg && glow){
    function moveGlow(x,y){
      px=x; py=y;
      if(raf) return;
      raf=requestAnimationFrame(()=>{
        glow.style.setProperty("--gx", px+"px");
        glow.style.setProperty("--gy", py+"px");
        raf=0;
      });
    }
    svg.addEventListener("pointermove", (e)=>{
      const r = svg.getBoundingClientRect();
      moveGlow(e.clientX - r.left, e.clientY - r.top);
    }, {passive:true});
  }

  // ---------- Parallax 3D ----------
  const scene = document.querySelector(".bgfx-scene");
  const layers = [...document.querySelectorAll("[data-depth]")];
  const prefersReduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
  let tx=0, ty=0, vx=0, vy=0, w=innerWidth, h=innerHeight;

  addEventListener("resize", ()=>{w=innerWidth;h=innerHeight},{passive:true});
  function onMove(x,y){
    const nx = (x / w) * 2 - 1;
    const ny = (y / h) * 2 - 1;
    tx = clamp(nx,-1,1);
    ty = clamp(ny,-1,1);
  }
  addEventListener("pointermove", e=>onMove(e.clientX,e.clientY), {passive:true});
  addEventListener("touchmove", e=>{
    if(!e.touches || !e.touches[0]) return;
    onMove(e.touches[0].clientX, e.touches[0].clientY);
  }, {passive:true});

  let usingDevice=false;
  function enableDevice(){
    if(usingDevice) return;
    usingDevice=true;
    addEventListener("deviceorientation", (e)=>{
      const gx=(e.gamma||0)/28;
      const by=(e.beta||0)/42;
      tx=clamp(gx,-1,1);
      ty=clamp(by,-1,1);
    }, {passive:true});
  }
  const btn=document.querySelector("[data-enable-gyro]");
  if(btn){
    btn.addEventListener("click", async ()=>{
      try{
        if(typeof DeviceOrientationEvent!=="undefined" && typeof DeviceOrientationEvent.requestPermission==="function"){
          const r=await DeviceOrientationEvent.requestPermission();
          if(r==="granted") enableDevice();
        } else enableDevice();
        btn.textContent="Gyro: ON";
        btn.classList.add("on");
      }catch(_){
        btn.textContent="Gyro indisponível";
      }
    });
  }

  function tickParallax(){
    if(prefersReduce){
      scene.style.transform="rotateX(0deg) rotateY(0deg)";
      layers.forEach(el=>el.style.transform=el.dataset.base||"");
      return;
    }
    vx += (tx - vx) * 0.08;
    vy += (ty - vy) * 0.08;

    const rx = (-vy*8.6).toFixed(3);
    const ry = (vx*10.8).toFixed(3);
    scene.style.transform = `rotateX(${rx}deg) rotateY(${ry}deg)`;

    layers.forEach(el=>{
      const d=parseFloat(el.dataset.depth||"0.2");
      const mx=(vx*32*d).toFixed(3);
      const my=(vy*24*d).toFixed(3);
      el.style.transform = `${el.dataset.base||""} translate3d(${mx}px, ${my}px, 0)`;
    });
    requestAnimationFrame(tickParallax);
  }
  requestAnimationFrame(tickParallax);

  // ---------- Pixel pine renderer (detailed like reference) ----------
  const far = document.getElementById("forestFar");
  const mid = document.getElementById("forestMid");
  const near = document.getElementById("forestNear");
  const ctxF = far.getContext("2d");
  const ctxM = mid.getContext("2d");
  const ctxN = near.getContext("2d");

  // Pixel Sea canvas (entre céu e floresta)
  const sea = document.getElementById("pixelSea");
  const ctxS = sea ? sea.getContext("2d") : null;

  const W = far.width, H = far.height;
  const horizon = Math.floor(H*0.54);
  const baseY = Math.floor(H*0.86);

  const rnd = mulberry32(2029);

  function pxRect(ctx,x,y,w,h,c){
    ctx.fillStyle=c;
    ctx.fillRect(Math.round(x),Math.round(y),Math.round(w),Math.round(h));
  }

  // Pixel pine (stepped branches)
  function drawPine(ctx, x, groundY, h, w, colDark, colMid, colLight, sway=0){
    const trunkH = Math.max(3, Math.floor(h*0.18));
    const canopyH = h - trunkH;

    // trunk (pixel)
    pxRect(ctx, x + w*0.46 + sway, groundY - trunkH, Math.max(1,w*0.10), trunkH, "rgba(16,10,8,.85)");

    // canopy as stepped layers
    const steps = Math.max(6, Math.floor(canopyH/6));
    for(let i=0;i<steps;i++){
      const y = groundY - trunkH - (i+1)*(canopyH/steps);
      const t = i/(steps-1);
      const half = (w*0.5) * (1 - t*0.88);
      const bandH = Math.max(1, Math.floor(canopyH/steps));
      // slight jagged edges
      const jag = ((i%2===0)? 1 : 0);
      const left = x + w*0.5 - half + sway - jag;
      const width = half*2 + jag*2;
      const shade = (t<0.25)? colLight : (t<0.65? colMid : colDark);
      pxRect(ctx, left, y, width, bandH, shade);
      // micro highlights on outer edges
      if(i%3===0){
        pxRect(ctx, left+1, y, 1, bandH, "rgba(255,255,255,.06)");
        pxRect(ctx, left+width-2, y, 1, bandH, "rgba(0,0,0,.08)");
      }
    }

    // top point
    pxRect(ctx, x + w*0.5 + sway, groundY - h, 1, 2, colLight);
  }

  function drawBush(ctx, x, y, s, c1, c2){
    pxRect(ctx, x, y, 8*s, 4*s, c1);
    pxRect(ctx, x+2*s, y-2*s, 6*s, 3*s, c2);
    pxRect(ctx, x+1*s, y+1*s, 6*s, 2*s, c2);
  }

  function clear(ctx){
    ctx.clearRect(0,0,W,H);
  }

  function drawLayer(ctx, palette, density, depthScale, time, swayAmp){
    // base color band (fog)
    // ground strip
    pxRect(ctx, 0, horizon, W, H-horizon, palette.ground);
    // mist band near horizon
    for(let i=0;i<10;i++){
      const a = 0.05 + i*0.015;
      pxRect(ctx, 0, horizon-12+i*2, W, 2, `rgba(255,255,255,${a.toFixed(3)})`);
    }

    // trees
    const count = Math.floor(density * 55);
    for(let i=0;i<count;i++){
      const x = Math.floor(rnd()*W);
      const h = Math.floor((16 + rnd()*44) * depthScale);
      const w = Math.max(8, Math.floor((10 + rnd()*18) * depthScale));
      const y = baseY + Math.floor(rnd()*10);
      const phase = (x/W)*3.2 + i*0.12;
      const sway = Math.sin(time*0.0016 + phase) * swayAmp;
      drawPine(ctx, x, y, h, w, palette.dark, palette.mid, palette.light, sway);
    }

    // bushes / small details near bottom
    const bcount = Math.floor(density*18);
    for(let i=0;i<bcount;i++){
      const x = Math.floor(rnd()*W);
      const y = baseY + Math.floor(rnd()*10);
      const s = 1 + Math.floor(rnd()*2);
      drawBush(ctx, x, y-6*s, s, palette.bush1, palette.bush2);
      // tiny flowers pixels
      if(rnd() > 0.78){
        pxRect(ctx, x+2*s, y-2*s, 1, 1, "rgba(255,90,110,.90)");
        pxRect(ctx, x+4*s, y-3*s, 1, 1, "rgba(255,220,120,.85)");
      }
    }

    // grass line
    for(let x=0;x<W;x+=3){
      const h = 1 + Math.floor(rnd()*3);
      pxRect(ctx, x, baseY - h, 1, h, palette.grass);
    }
  }

  const palettes = {
    far:   {dark:"#0d2a2d", mid:"#134449", light:"#1c6c64", ground:"#061418", bush1:"#174645", bush2:"#1d5f58", grass:"#1a6f63"},
    mid:   {dark:"#0a2734", mid:"#0f3b4c", light:"#1a6f7a", ground:"#061318", bush1:"#15515b", bush2:"#1b6c6d", grass:"#1aa18a"},
    near:  {dark:"#072233", mid:"#0c3550", light:"#1b6c7e", ground:"#061318", bush1:"#2c9e76", bush2:"#40b48b", grass:"#59d19c"},
  };

  // Reset deterministic random every frame (so it doesn't "crawl")
  function resetRng(){
    // just reassign rnd closure by recreating function using same seed
    // (we keep mulberry32 deterministic)
  }

  // We'll pre-generate "tree placements" so sway animates without layout changing
  function makeTreeField(seed, count, depthScale){
    const r = mulberry32(seed);
    const trees=[];
    for(let i=0;i<count;i++){
      const x = Math.floor(r()*W);
      const h = Math.floor((16 + r()*44) * depthScale);
      const w = Math.max(8, Math.floor((10 + r()*18) * depthScale));
      const y = baseY + Math.floor(r()*10);
      const phase = (x/W)*3.2 + i*0.12;
      trees.push({x,y,h,w,phase});
    }
    const bushes=[];
    const bcount = Math.floor((count/55)*18);
    for(let i=0;i<bcount;i++){
      const x = Math.floor(r()*W);
      const y = baseY + Math.floor(r()*10);
      const s = 1 + Math.floor(r()*2);
      const flower = r()>0.78;
      bushes.push({x,y,s,flower,fx: x+2*s, fy:y-2*s, fx2:x+4*s, fy2:y-3*s});
    }
    const grass=[];
    for(let x=0;x<W;x+=3){
      grass.push({x, h: 1 + Math.floor(r()*3)});
    }
    return {trees,bushes,grass};
  }

  const fieldFar = makeTreeField(3101, 52, 0.72);
  const fieldMid = makeTreeField(3102, 64, 0.95);
  const fieldNear= makeTreeField(3103, 78, 1.22);

  function renderField(ctx, field, palette, time, swayAmp){
    // clear
    ctx.clearRect(0,0,W,H);

    // land strip (deixa o mar aparecer acima)
    const landY = baseY - 10;
    pxRect(ctx, 0, landY, W, H-landY, palette.ground);

    // sombra suave acima da terra
    pxRect(ctx, 0, landY-3, W, 3, "rgba(0,0,0,.22)");

    // trees
    for(let i=0;i<field.trees.length;i++){
      const t=field.trees[i];
      const sway = Math.sin(time*0.0017 + t.phase) * swayAmp;
      drawPine(ctx, t.x, t.y, t.h, t.w, palette.dark, palette.mid, palette.light, sway);
    }

    // bushes + flowers
    for(let i=0;i<field.bushes.length;i++){
      const b=field.bushes[i];
      drawBush(ctx, b.x, b.y-6*b.s, b.s, palette.bush1, palette.bush2);
      if(b.flower){
        pxRect(ctx, b.fx, b.fy, 1, 1, "rgba(255,90,110,.90)");
        pxRect(ctx, b.fx2, b.fy2, 1, 1, "rgba(255,220,120,.85)");
      }
    }

    // grass (linha principal)
    for(let i=0;i<field.grass.length;i++){
      const g=field.grass[i];
      pxRect(ctx, g.x, baseY - g.h, 1, g.h, palette.grass);
    }

    // ---------- Foreground fill (grama + flores + sapinho) ----------
    // Só no layer near (para não "poluir" as camadas de trás)
    if(palette === palettes.near){
      // Tapete de graminha pixelada cobrindo o "preto" (do baseY até o fim)
      for(let y=baseY; y<H; y+=2){
        for(let x=0; x<W; x+=2){
          const n = ((x*23 + y*31) % 97) / 97;
          if(n < 0.16){
            pxRect(ctx, x, y, 1, 1, palette.grass);
          }else if(n > 0.92){
            pxRect(ctx, x, y, 1, 1, "rgba(0,0,0,.25)");
          }
        }
      }

      // Tufts (moitinhas) para dar volume
      for(let i=0;i<18;i++){
        const x = (i*37*11) % W;
        const y = baseY + 2 + ((i*19) % Math.max(6, (H-baseY-10)));
        const h = 3 + (i % 5);
        // haste
        pxRect(ctx, x, y, 1, h, palette.grass);
        pxRect(ctx, x+1, y+1, 1, h-1, palette.grass);
        // pontas
        pxRect(ctx, x-1, y, 1, 1, "rgba(255,255,255,.08)");
        pxRect(ctx, x+2, y+1, 1, 1, "rgba(255,255,255,.06)");
      }

      // Flores pixeladas (bem pequenas)
      const flowerColors = [
        "rgba(255,120,150,.95)", // rosa
        "rgba(255,230,120,.95)", // amarelo
        "rgba(160,220,255,.95)", // azul claro
        "rgba(210,170,255,.95)"  // lilás
      ];
      for(let i=0;i<12;i++){
        const fx = (i*53*7 + 31) % (W-8);
        const fy = baseY + 5 + ((i*23) % Math.max(6, (H-baseY-14)));
        const c = flowerColors[i % flowerColors.length];
        // flor 3x3
        pxRect(ctx, fx+1, fy, 1, 1, c);
        pxRect(ctx, fx, fy+1, 1, 1, c);
        pxRect(ctx, fx+1, fy+1, 1, 1, "rgba(255,255,255,.92)");
        pxRect(ctx, fx+2, fy+1, 1, 1, c);
        pxRect(ctx, fx+1, fy+2, 1, 1, c);
        // haste
        pxRect(ctx, fx+1, fy+3, 1, 2, palette.grass);
      }

      // Lagoa pixelada + logo pequena (2 vitórias-régias) — LIMPA (sem pontinhos)
      const pondCX = Math.floor(W*0.46);
      const pondCY = baseY + 24;     // em cima do tapete de grama
      const pondW  = 36;
      const pondH  = 16;

      const waterA = "rgba(18,95,120,.98)";
      const waterB = "rgba(10,60,85,.98)";
      const waterC = "rgba(6,35,55,.98)";
      const edge   = "rgba(0,0,0,.35)";
      const shine  = "rgba(255,255,255,.08)";

      // lagoa (oval pixelado, preenchimento sólido por bandas — cobre qualquer "pontinho" de baixo)
      for(let yy=-pondH; yy<=pondH; yy+=2){
        for(let xx=-pondW; xx<=pondW; xx+=2){
          const nx = xx/pondW;
          const ny = yy/pondH;
          const d = nx*nx + ny*ny;
          if(d <= 1.0){
            const x = pondCX + xx;
            const y = pondCY + yy;

            // degradê suave (3 cores) — sem divisões
            const t = (ny+1)/2; // 0..1 (topo -> baixo)

            // waterA (claro), waterB (médio), waterC (escuro)
            // Interpola A->B até 0.55, depois B->C
            function lerp(a,b,u){ return a + (b-a)*u; }
            const A = [18,95,120];
            const B = [10,60,85];
            const C = [6,35,55];

            let r,g,b;
            if(t <= 0.55){
              const u = t/0.55;
              r = Math.round(lerp(A[0], B[0], u));
              g = Math.round(lerp(A[1], B[1], u));
              b = Math.round(lerp(A[2], B[2], u));
            }else{
              const u = (t-0.55)/(0.45);
              r = Math.round(lerp(B[0], C[0], u));
              g = Math.round(lerp(B[1], C[1], u));
              b = Math.round(lerp(B[2], C[2], u));
            }
            const col = `rgba(${r},${g},${b},.98)`;


            pxRect(ctx, x, y, 2, 2, col);
          }
        }
      }
      // contorno simples (borda) para ficar "logo" bem definida
      for(let xx=-pondW; xx<=pondW; xx+=2){
        const nx = xx/pondW;
        const yyTop = Math.round(-pondH * Math.sqrt(Math.max(0, 1 - nx*nx)));
        const yyBot = Math.round(+pondH * Math.sqrt(Math.max(0, 1 - nx*nx)));
        pxRect(ctx, pondCX+xx, pondCY+yyTop, 2, 2, edge);
        pxRect(ctx, pondCX+xx, pondCY+yyBot, 2, 2, edge);
      }
      // brilho leve na parte superior
      for(let i=0;i<10;i++){
        const x = pondCX - pondW + 4 + i*6;
        const y = pondCY - pondH + 6 + (i%2);
        pxRect(ctx, x, y, 2, 1, shine);
      }

      // Duas vitórias-régias (logo pequena)
      const pad1 = "rgba(70,205,140,.95)";
      const pad2 = "rgba(50,175,120,.95)";
      const pad3 = "rgba(25,110,80,.95)";
      const hl   = "rgba(255,255,255,.12)";

      function lilyPad(x,y,scale=1){
        pxRect(ctx, x+1*scale, y+3*scale, 7*scale, 3*scale, pad2);
        pxRect(ctx, x+2*scale, y+2*scale, 5*scale, 1*scale, pad2);
        pxRect(ctx, x+2*scale, y+1*scale, 5*scale, 1*scale, pad1);
        pxRect(ctx, x+3*scale, y+0*scale, 3*scale, 1*scale, pad1);

        pxRect(ctx, x+1*scale, y+5*scale, 7*scale, 1*scale, pad3);
        pxRect(ctx, x+0*scale, y+4*scale, 1*scale, 2*scale, pad3);
        pxRect(ctx, x+8*scale, y+4*scale, 1*scale, 2*scale, pad3);

        // fenda
        pxRect(ctx, x+4*scale, y+3*scale, 1*scale, 2*scale, "rgba(0,0,0,.28)");

        // highlight
        pxRect(ctx, x+2*scale, y+2*scale, 2*scale, 1*scale, hl);
        pxRect(ctx, x+3*scale, y+1*scale, 2*scale, 1*scale, hl);
      }

      lilyPad(pondCX-16, pondCY-6, 1);
      lilyPad(pondCX-2,  pondCY-10, 1);

      // miolo (florzinha minúscula)
      pxRect(ctx, pondCX-1, pondCY-2, 1, 1, "rgba(255,230,140,.92)");

      // Pedras pixeladas do lado ESQUERDO da logo (em volta)
      const rock1 = "rgba(120,130,145,.92)";
      const rock2 = "rgba(80,90,110,.92)";
      const rock3 = "rgba(45,55,70,.92)";

      function rockCluster(rx, ry){
        // 6x4 blob
        pxRect(ctx, rx+1, ry+1, 4, 2, rock2);
        pxRect(ctx, rx+2, ry+0, 2, 1, rock1);
        pxRect(ctx, rx+0, ry+2, 1, 1, rock3);
        pxRect(ctx, rx+5, ry+2, 1, 1, rock3);
        pxRect(ctx, rx+2, ry+3, 2, 1, rock3);
        pxRect(ctx, rx+3, ry+1, 1, 1, "rgba(255,255,255,.10)");
      }

      rockCluster(pondCX - pondW - 18, pondCY - 6);
      rockCluster(pondCX - pondW - 10, pondCY + 2);
      rockCluster(pondCX - pondW - 22, pondCY + 8);

      // Sapinho pixelado — à direita da lagoa
      const sx = pondCX + pondW + 10;
      const sy = pondCY + 4;

      const g1 = "rgba(110,235,160,.95)";
      const g2 = "rgba(70,190,120,.95)";
      const o  = "rgba(5,10,12,.85)";
      const w  = "rgba(255,255,255,.95)";

      // corpo
      pxRect(ctx, sx+2, sy+4, 8, 4, g2);
      pxRect(ctx, sx+3, sy+3, 6, 1, g2);
      pxRect(ctx, sx+3, sy+5, 6, 2, g1);
      // patinhas
      pxRect(ctx, sx+1, sy+6, 2, 2, g2);
      pxRect(ctx, sx+9, sy+6, 2, 2, g2);
      // cabeça
      pxRect(ctx, sx+3, sy+1, 6, 3, g2);
      pxRect(ctx, sx+4, sy+2, 4, 1, g1);
      // olhos
      pxRect(ctx, sx+3, sy, 2, 2, g2);
      pxRect(ctx, sx+7, sy, 2, 2, g2);
      pxRect(ctx, sx+4, sy+1, 1, 1, w);
      pxRect(ctx, sx+7, sy+1, 1, 1, w);
      pxRect(ctx, sx+5, sy+1, 1, 1, o);
      pxRect(ctx, sx+8, sy+1, 1, 1, o);
      // boquinha
      pxRect(ctx, sx+5, sy+3, 2, 1, o);



      // Vagalumes pixelados (movimento + piscar)
      const baseCount = 22;

      for(let i=0;i<baseCount;i++){
        // posição base determinística
        const bx = (i*47*13 + 19) % (W-18);
        const by = baseY + 4 + ((i*29) % Math.max(10, (H-baseY-22)));

        // movimento suave (drift) — sem ficar louco
        const t1 = time*0.0009 + i*1.37;
        const t2 = time*0.0007 + i*0.91;

        const dx = Math.round(Math.sin(t1) * (3 + (i%3)));   // -6..6
        const dy = Math.round(Math.cos(t2) * (2 + (i%2)));   // -3..3

        const x = bx + dx;
        const y = by + dy;

        // piscar (twinkle)
        const tw = (Math.sin(time*0.0024 + i*1.6) * 0.5 + 0.5); // 0..1
        const a  = (0.10 + tw*0.70).toFixed(3);

        // cor vagalume
        const c  = `rgba(255,230,140,${a})`;

        // pontinho principal
        pxRect(ctx, x, y, 1, 1, c);

        // glow em cruz (sutil)
        const ag = (0.05 + tw*0.22).toFixed(3);
        const cg = `rgba(255,230,140,${ag})`;
        pxRect(ctx, x-1, y, 1, 1, cg);
        pxRect(ctx, x+1, y, 1, 1, cg);
        pxRect(ctx, x, y-1, 1, 1, cg);
        pxRect(ctx, x, y+1, 1, 1, cg);

        // traço curtinho (como rastro bem leve)
        if(tw > 0.72){
          pxRect(ctx, x-2, y+1, 1, 1, `rgba(255,200,120,${(0.05+tw*0.10).toFixed(3)})`);
        }
      }

    }
  }



  // ---------- Pixel Sea renderer (ESTÁTICO: sem animação) ----------
  function renderSea(){
    if(!ctxS) return;
    const S = ctxS;
    S.clearRect(0,0,W,H);

    // Sea occupies from horizon to just above land
    const seaTop = horizon;
    const landY = baseY - 10;
    const seaBottom = landY;

    // Base ocean gradient (bandas pixel)
    for(let y=seaTop; y<seaBottom; y+=2){
      const t = (y-seaTop)/(seaBottom-seaTop);
      const r = Math.floor(6 + t*10);
      const g = Math.floor(18 + t*28);
      const b = Math.floor(34 + t*42);
      S.fillStyle = `rgb(${r},${g},${b})`;
      S.fillRect(0,y,W,2);
    }

    // Horizon mist band (suave)
    for(let i=0;i<7;i++){
      const a = 0.08 + i*0.018;
      S.fillStyle = `rgba(255,220,170,${a.toFixed(3)})`;
      S.fillRect(0, seaTop-6+i, W, 1);
    }

    // Sun reflection column (fixo)
    const cx = Math.floor(W*0.50);
    const colW = 28;

    for(let y=seaTop+8; y<seaBottom; y+=3){
      const t = (y-seaTop)/(seaBottom-seaTop);
      const spread = Math.floor((1-t) * colW + 6);
      const alpha = (0.18*(1-t) + 0.03).toFixed(3);
      const left = cx - spread;
      const width = spread*2;

      for(let x=left; x<left+width; x+=3){
        const n = ((x*19 + y*13) % 17)/17; // determinístico (sem tempo)
        if(n < 0.25 + (1-t)*0.08){
          S.fillStyle = `rgba(255,210,140,${alpha})`;
          S.fillRect(x, y, 2, 1);
        }
      }
    }
    // Depth edges
    S.fillStyle = "rgba(0,0,0,.16)";
    S.fillRect(0, seaTop, 16, seaBottom-seaTop);
    S.fillRect(W-16, seaTop, 16, seaBottom-seaTop);
  }




  function animate(t){
    // mar (entre horizonte e floresta)
    renderSea();

    // sway amplitude stronger near
    renderField(ctxF, fieldFar, palettes.far, t, 0.6);
    renderField(ctxM, fieldMid, palettes.mid, t, 1.1);
    renderField(ctxN, fieldNear, palettes.near, t, 1.8);
    requestAnimationFrame(animate);
  }
  requestAnimationFrame(animate);

  // ---------- Pixel Sun (nascer do sol em pixel art) ----------
  const sunCanvas = document.getElementById("pixelSun");
  if(sunCanvas){
    const sctx = sunCanvas.getContext("2d");
    const SW = sunCanvas.width, SH = sunCanvas.height;

    function drawPixelSun(time){
      // Clear
      sctx.clearRect(0,0,SW,SH);

      // Horizon line position (matches visual split around middle of the scene)
      const horizonY = Math.floor(SH * 0.56);

      // Sun params
      const cx = Math.floor(SW * 0.50);
      const cy = Math.floor(SH * 0.62); // slightly below horizon so it "rises"
      const r  = Math.floor(Math.min(SW,SH) * 0.17);

      // Rising animation (subtle)
      const rise = Math.sin(time*0.00025) * 3.0;
      const sunY = cy - rise;

      // Pixel size (bigger = more pixelated)
      const ps = 3;

      // Precompute palette
      const core = [255, 224, 140];
      const mid  = [255, 196, 110];
      const rim  = [255, 160,  90];

      // Draw sun circle in pixels (dither + gradient)
      for(let y=0; y<SH; y+=ps){
        for(let x=0; x<SW; x+=ps){
          const dx = (x + ps*0.5) - cx;
          const dy = (y + ps*0.5) - sunY;
          const d = Math.sqrt(dx*dx + dy*dy);

          // Only draw above a soft horizon mask (so it looks like sunrise)
          // We allow the sun to be partially occluded by the horizon band:
          const occlude = (y > horizonY + 6);

          if(d <= r){
            // Simple radial gradient + a tiny dithering
            const t = d / r; // 0 center -> 1 edge
            const noise = ((x*17 + y*29) % 11) / 11.0; // deterministic
            let rr, gg, bb, a;

            if(t < 0.45){
              rr = core[0]; gg = core[1]; bb = core[2]; a = 0.95;
            }else if(t < 0.78){
              rr = mid[0]; gg = mid[1]; bb = mid[2]; a = 0.85;
            }else{
              rr = rim[0]; gg = rim[1]; bb = rim[2]; a = 0.70;
            }

            // Dither on the edge for a pixel-art vibe
            if(t > 0.70 && noise < 0.25) a *= 0.55;

            // Occlude part of the sun under the horizon (pixel-perfect)
            if(occlude){
              // Keep a few glow pixels to blend with the band
              if(noise < 0.10) a *= 0.25;
              else continue;
            }

            sctx.fillStyle = `rgba(${rr},${gg},${bb},${a})`;
            sctx.fillRect(x, y, ps, ps);
          }
        }
      }

      // Add a subtle pixel glow halo (also pixelated)
      const haloR = r * 2.1;
      for(let y=0; y<SH; y+=ps){
        for(let x=0; x<SW; x+=ps){
          const dx = (x + ps*0.5) - cx;
          const dy = (y + ps*0.5) - sunY;
          const d = Math.sqrt(dx*dx + dy*dy);
          if(d > r && d < haloR){
            const t = (d - r) / (haloR - r);
            const a = (1 - t) * 0.10;
            if(a < 0.01) continue;
            // Keep halo mostly above horizon
            if(y > horizonY + 18) continue;
            sctx.fillStyle = `rgba(255,180,110,${a.toFixed(3)})`;
            sctx.fillRect(x, y, ps, ps);
          }
        }
      }
    }

    // Hook into existing animation loop if present; otherwise animate here.
    // We'll create a lightweight RAF for the sun only.
    function sunLoop(t){
      drawPixelSun(t);
      requestAnimationFrame(sunLoop);
    }
    requestAnimationFrame(sunLoop);
  }
})();


/* ===== Karameloo: No-Auth Home + Loader failsafe (added) ===== */
(function(){
  function safeHide(){
    try{ hideLoading(); }catch(e){}
    try{
      const gl = document.getElementById('globalLoader');
      if(gl) gl.classList.remove('show');
    }catch(e){}
  }

  window.addEventListener('error', safeHide);
  window.addEventListener('unhandledrejection', safeHide);

  function bindHome(){
    const btnClient = document.getElementById('homeClientBtn');
    const btnEditor = document.getElementById('homeEditorBtn');

    if(btnClient){
      btnClient.addEventListener('click', ()=>{
        try{ safeHide(); }catch(e){}
        try{ showScreen(screenClientProfile, true); }catch(e){
          // fallback: go explore
          try{ showScreen(screenProcurar, true); }catch(_e){}
        }
      });
    }

    if(btnEditor){
      btnEditor.addEventListener('click', ()=>{
        try{ safeHide(); }catch(e){}
        try{ showScreen(screenEditor, true); }catch(e){
          try{ showScreen(screenProcurar, true); }catch(_e){}
        }
      });
    }

    // Guarantees we always start on the initial screen
    try{
      safeHide();
      if(typeof showScreen === 'function' && typeof screenStart !== 'undefined'){
        showScreen(screenStart, true);
      }
    }catch(e){}
  }

  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', bindHome);
  }else{
    bindHome();
  }
})();

