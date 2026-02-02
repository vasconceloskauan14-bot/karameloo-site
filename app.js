/* Karameloo - app.js (build v28 - editor_supabase_ready)
   - Frontend dividido (index + styles + app)
   - Gatilhos Supabase centralizados: Auth, profiles, orders, chat
   - Mantém modo demo/local quando Supabase não estiver disponível
*/

// ===== Util =====
    const MAX_STARS = 10;

  // CPF validation (Brazil)
  function isValidCPF(cpf){
    cpf = (cpf || "").toString().replace(/\D/g, "");
    if (cpf.length !== 11) return false;
    if (/^(\d)\1{10}$/.test(cpf)) return false; // reject all equal digits

    let sum = 0;
    for (let i = 0; i < 9; i++) sum += parseInt(cpf.charAt(i), 10) * (10 - i);
    let rev = 11 - (sum % 11);
    if (rev === 10 || rev === 11) rev = 0;
    if (rev !== parseInt(cpf.charAt(9), 10)) return false;

    sum = 0;
    for (let i = 0; i < 10; i++) sum += parseInt(cpf.charAt(i), 10) * (11 - i);
    rev = 11 - (sum % 11);
    if (rev === 10 || rev === 11) rev = 0;
    return rev === parseInt(cpf.charAt(10), 10);
  }

    // expõe para o escopo global (evita erro 'isValidCPF is not defined' em handlers inline)
    window.isValidCPF = isValidCPF;

    // menor (fluxo antigo) foi desativado: mantém variável para evitar erro em versões antigas
    let isMinorEditor = false;
// ===== Supabase (Auth + Banco) =====
    // IMPORTANTE: anon key é pública. NUNCA coloque a service_role no frontend.
    const SUPABASE_URL = "https://qnraiayglvluzhuyigje.supabase.co";
    const SUPABASE_ANON_KEY = "sb_publishable_6P7JM9YccqYP2vPXNXOPdw_ogHZWqXF";
    const supaLib = window.supabase;
    const supaClient = (supaLib && typeof supaLib.createClient === 'function')
      ? supaLib.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    storage: window.sessionStorage
  }
})
      : null;
    const SUPABASE_ENABLED = !!supaClient;
    window.supaClient = supaClient;
    window.SUPABASE_ENABLED = SUPABASE_ENABLED;


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

    async function supaRegisterFlow({ nome, sobrenome, dob, cpfD, email, senha, roleUi, addr }){
      if(!SUPABASE_ENABLED) throw new Error('Supabase não inicializou.');

      const displayName = `${nome} ${sobrenome}`.trim();
      const roleValue = (roleUi === 'cliente') ? 'client' : 'editor';

      const { data, error } = await supaClient.auth.signUp({
        email,
        password: senha,
        options: { data: { display_name: displayName, role: roleValue, dob: dob || null, addr: addr || null } }
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

      // cria row em 'editors' para TODO mundo (cliente já nasce com perfil de editor desativado)
      {
        const isActive = (roleValue === 'editor');
        const { error: eErr } = await supaClient
          .from('editors')
          .upsert(
            { user_id: data.user.id, headline: 'Editor', bio: '', skills: [], is_active: isActive },
            { onConflict: 'user_id' }
          );
        if(eErr) console.warn('Falha ao criar/atualizar editor row:', eErr.message);
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

      // garante que existe row de editor para o usuário (cliente fica desativado)
      {
        const isActive = ((prof?.role || 'client') === 'editor');
        const { error: eErr } = await supaClient
          .from('editors')
          .upsert(
            { user_id: userId, headline: 'Editor', bio: '', skills: [], is_active: isActive },
            { onConflict: 'user_id' }
          );
        if(eErr) console.warn('Falha ao garantir editor row:', eErr.message);
      }

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
    function parseBrl(txt){
  const s = String(txt||'').replace(/[^0-9,.-]/g,'').replace(/\./g,'').replace(',','.');
  const n = Number(s);
  return isFinite(n) ? n : 0;
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
      // Fonte principal: sessão (sessionStorage)
      const s = getSession();
      if(s.active==='cliente' && !!(s.clientEmail)) return true;

      // Fallback: se existir perfil de cliente salvo, sincroniza a sessão
      try{
        const c = lsGet(LS_CLIENT, null);
        const email = (c && c.email) ? String(c.email).trim() : '';
        if(email){
          s.active = 'cliente';
          s.clientEmail = email;
          setSession(s);
          return true;
        }
      }catch(e){}

      // Fallback 2: clientData em memória
      try{
        const email2 = (clientData && clientData.email) ? String(clientData.email).trim() : '';
        if(email2){
          s.active = 'cliente';
          s.clientEmail = email2;
          setSession(s);
          return true;
        }
      }catch(e){}

      return false;
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
      }catch(e){  }

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
      }catch(e){  }

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
      }catch(e){  }

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

    // ===== Termos / Privacidade (documentos completos) =====
    const legalOverlay = document.getElementById('legalOverlay');
    const legalModal = document.getElementById('legalModal');
    const legalTitle = document.getElementById('legalTitle');
    const legalBody = document.getElementById('legalBody');

    const LEGAL_TERMS_HTML = `<div class="legalTabs">
  <button class="btn secondary small" type="button" onclick="openTerms()">Termos de Uso</button>
  <button class="btn secondary small" type="button" onclick="openPrivacy()">Privacidade</button>
</div>

<h3>Termos de Uso</h3>
<p><strong>Última atualização:</strong> 30/01/2026</p>

<p>Bem-vindo ao <strong>Karameloo</strong> (“plataforma”, “nós”). Ao acessar ou usar este site, você concorda com estes Termos.</p>

<h4>1) Quem pode usar</h4>
<ul>
  <li><strong>Idade mínima:</strong> 16 anos. Se você tiver menos de 16, não crie conta nem use a plataforma.</li>
  <li>Ao criar conta, você declara que as informações fornecidas são verdadeiras (nome, CPF, e-mail e data de nascimento).</li>
</ul>

<h4>2) O que é o Karameloo</h4>
<ul>
  <li>O Karameloo conecta <strong>clientes</strong> a <strong>editores</strong> (vídeo, foto, áudio, animação e similares).</li>
  <li>O Karameloo não garante resultados criativos específicos, pois cada projeto depende de briefing, arquivos enviados e comunicação entre as partes.</li>
</ul>

<h4>3) Conta, segurança e responsabilidades</h4>
<ul>
  <li>Você é responsável por manter seus dados de acesso seguros.</li>
  <li>É proibido criar múltiplas contas para burlar regras, avaliações, limites ou pagamentos.</li>
  <li>Podemos suspender ou encerrar contas em caso de fraude, abuso, violação destes Termos ou tentativa de prejudicar a plataforma.</li>
</ul>

<h4>4) Conteúdo enviado (arquivos, mensagens e portfólio)</h4>
<ul>
  <li>Você mantém os direitos sobre seus arquivos, mas concede ao Karameloo permissão para <strong>hospedar, processar e exibir</strong> o conteúdo necessário para executar o serviço (ex.: mostrar portfólio, prévias, mensagens e entrega).</li>
  <li>Você não pode enviar conteúdo ilegal, ofensivo, discriminatório, violento, sexual explícito envolvendo menores, ou qualquer material que viole direitos autorais/marca de terceiros.</li>
  <li>Se você enviar conteúdo de terceiros, você declara ter autorização para usar e compartilhar.</li>
</ul>

<h4>5) Pagamentos, comissões e reembolsos (beta)</h4>
<ul>
  <li>As regras de preço, comissão e repasse podem variar conforme o pacote/condições exibidas no site.</li>
  <li>No beta, algumas funcionalidades podem ser demonstrativas. Quando houver backend/pagamentos reais, serão adicionadas regras completas de cobrança, repasse e reembolso.</li>
</ul>

<h4>6) Regras de conduta</h4>
<ul>
  <li>Não assedie, ameace, engane ou tente tirar usuários para fora da plataforma com objetivo de evitar regras/comissões.</li>
  <li>Não explore falhas, não faça engenharia social e não tente acessar dados de outros usuários.</li>
</ul>

<h4>7) Moderação e remoções</h4>
<ul>
  <li>Podemos remover conteúdo, mensagens, portfólios ou perfis que violem estes Termos.</li>
  <li>Podemos aplicar filtros automáticos e revisão manual. A moderação completa exige backend e poderá evoluir.</li>
</ul>

<h4>8) Limitação de responsabilidade</h4>
<ul>
  <li>O Karameloo é fornecido “como está”. Podemos melhorar, alterar ou interromper recursos a qualquer momento.</li>
  <li>Não nos responsabilizamos por perdas indiretas (ex.: lucros cessantes) ou por conteúdo publicado/enviado por usuários.</li>
</ul>

<h4>9) Alterações destes Termos</h4>
<p>Podemos atualizar estes Termos. Quando isso acontecer, a data de “última atualização” será alterada e as novas regras passam a valer a partir da publicação.</p>

<h4>10) Contato</h4>
<p>Para dúvidas, use o canal de suporte exibido no site (ou o chat interno, quando disponível).</p>`;
    const LEGAL_PRIVACY_HTML = `<div class="legalTabs">
  <button class="btn secondary small" type="button" onclick="openTerms()">Termos de Uso</button>
  <button class="btn secondary small" type="button" onclick="openPrivacy()">Privacidade</button>
</div>

<h3>Política de Privacidade</h3>
<p><strong>Última atualização:</strong> 30/01/2026</p>

<p>Esta Política descreve como o <strong>Karameloo</strong> trata dados pessoais, conforme princípios da <strong>LGPD</strong>.</p>

<h4>1) Quais dados podemos coletar</h4>
<ul>
  <li><strong>Cadastro:</strong> nome, sobrenome, e-mail, CPF e data de nascimento.</li>
  <li><strong>Uso da plataforma:</strong> preferências, pacotes escolhidos, mensagens (quando houver chat), avaliações e histórico de pedidos.</li>
  <li><strong>Arquivos:</strong> mídias enviadas para edição e materiais de portfólio (quando você optar por publicar).</li>
  <li><strong>Dados técnicos:</strong> informações de navegação (ex.: dispositivo, navegador, IP) para segurança e prevenção a fraude.</li>
</ul>

<h4>2) Como usamos os dados</h4>
<ul>
  <li>Para criar e manter sua conta.</li>
  <li>Para intermediar pedidos, comunicação e entregas.</li>
  <li>Para prevenir fraude, abuso e acessos indevidos.</li>
  <li>Para melhorar o produto (métricas, desempenho e correção de bugs).</li>
</ul>

<h4>3) Base legal (LGPD)</h4>
<ul>
  <li>Execução de contrato/serviço (para operar o marketplace).</li>
  <li>Legítimo interesse (segurança, prevenção a fraude e melhoria).</li>
  <li>Cumprimento de obrigações legais (quando aplicável).</li>
</ul>

<h4>4) Compartilhamento</h4>
<ul>
  <li>Podemos compartilhar dados com prestadores essenciais (ex.: hospedagem, banco de dados e ferramentas de segurança), apenas para operar o serviço.</li>
  <li>Não vendemos seus dados pessoais.</li>
</ul>

<h4>5) Armazenamento e segurança (importante no beta)</h4>
<ul>
  <li>No beta, parte dos dados pode ficar salva localmente no seu navegador (<strong>LocalStorage</strong>), o que significa que limpar o navegador pode apagar dados.</li>
  <li>Em produção, o objetivo é usar backend (ex.: banco de dados) com autenticação e políticas de segurança (RLS, perfis e logs).</li>
</ul>

<h4>6) Cookies e tecnologias similares</h4>
<p>Podemos usar cookies ou armazenamento local para manter sessão, preferências e segurança. Você pode gerenciar isso nas configurações do navegador.</p>

<h4>7) Seus direitos</h4>
<ul>
  <li>Confirmar se tratamos seus dados e solicitar acesso.</li>
  <li>Corrigir dados incompletos ou desatualizados.</li>
  <li>Solicitar anonimização, bloqueio ou eliminação (quando aplicável).</li>
  <li>Revogar consentimento (quando a base legal for consentimento).</li>
</ul>

<h4>8) Retenção</h4>
<p>Guardamos dados pelo tempo necessário para operar a plataforma e cumprir obrigações legais. Em beta/sessionStorage, a retenção depende do seu navegador.</p>

<h4>9) Contato</h4>
<p>Para exercer direitos ou tirar dúvidas, use o canal de suporte exibido no site.</p>`;

    function isLegalOpen(){
      return !!(legalOverlay && legalOverlay.classList.contains('show'));
    }

    function openLegal(kind){
      if(!legalOverlay || !legalBody) return;

      // fecha menu se estiver aberto
      try{ if(typeof closeUserMenu === 'function' && menuOverlay?.classList.contains('show')) closeUserMenu(); }catch(e){}

      legalOverlay.classList.remove('closing');
      legalOverlay.classList.add('show');
      legalOverlay.setAttribute('aria-hidden','false');
      document.body.style.overflow = 'hidden';

      if(legalModal){
        legalModal.classList.remove('closing');
        legalModal.style.animation = 'none';
        void legalModal.offsetHeight;
        legalModal.style.animation = '';
      }

      if(kind === 'privacy'){
        if(legalTitle) legalTitle.textContent = 'Privacidade';
        legalBody.innerHTML = LEGAL_PRIVACY_HTML;
      }else{
        if(legalTitle) legalTitle.textContent = 'Termos de Uso';
        legalBody.innerHTML = LEGAL_TERMS_HTML;
      }
    }

    function closeLegal(){
      if(!legalOverlay) return;
      legalOverlay.classList.add('closing');
      legalModal?.classList.add('closing');
      setTimeout(()=>{
        legalOverlay.classList.remove('show','closing');
        legalOverlay.setAttribute('aria-hidden','true');
        // libera scroll (desde que não exista outro overlay travando)
        document.body.style.overflow = '';
      }, 180);
    }

    function openTerms(){ openLegal('terms'); }
    function openPrivacy(){ openLegal('privacy'); }

    // fechar clicando no fundo
    if(legalOverlay){
      legalOverlay.addEventListener('click', (e)=>{
        if(e.target === legalOverlay) closeLegal();
      });
    }

function renderUserMenuPrivacy(){
      openPrivacy();
    }

    function renderUserMenuTerms(){
      openTerms();
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
        for(let i=0;i<sessionStorage.length;i++){
          const k = sessionStorage.key(i);
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
        // Não trava a navegação por causa de sessionStorage inconsistente
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
        const raw = sessionStorage.getItem(key);
        if(!raw) return fallback;
        return JSON.parse(raw);
      }catch(e){ return fallback; }
    }
    function lsSet(key, value){
      try{ sessionStorage.setItem(key, JSON.stringify(value)); }catch(e){}
    }

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
    const __PASS_EYE = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>`;
    const __PASS_EYE_OFF = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.94 17.94A10.94 10.94 0 0 1 12 19c-6.5 0-10-7-10-7a20.77 20.77 0 0 1 5.06-5.94"/><path d="M1 1l22 22"/><path d="M9.9 9.9a3 3 0 0 0 4.24 4.24"/><path d="M14.12 14.12 9.88 9.88"/><path d="M12 5c6.5 0 10 7 10 7a20.77 20.77 0 0 1-4.37 5.08"/></svg>`;
    function togglePass(id, btn){
      const el = document.getElementById(id);
      if(!el) return;
      const isPw = (el.type === 'password');
      el.type = isPw ? 'text' : 'password';
      if(btn){
        btn.innerHTML = isPw ? __PASS_EYE_OFF : __PASS_EYE;
        btn.setAttribute('aria-label', isPw ? 'Ocultar senha' : 'Mostrar senha');
      }
    }

    async function openAuth(mode, tipo){
      // Abre a tela de Auth (tela inteira).
      openCadastro(tipo || 'cliente');
      setAuthMode(mode === 'login' ? 'login' : 'register', false);
    }

    const inNome = document.getElementById('inNome');
    const inSobrenome = document.getElementById('inSobrenome');

    const clientName = document.getElementById('clientName');
    const editorName = document.getElementById('editorName');

    let role = null;
    let currentOrder = null;

    // ===== Auth modal (Cadastro/Login) =====
    const authWrap = document.getElementById('authWrap');
    const viewRegister = document.getElementById('viewRegister');
    const viewLogin = document.getElementById('viewLogin');
    const toLogin = document.getElementById('toLogin');
    const toRegister = document.getElementById('toRegister');
    const btnLogin = document.getElementById('btnLogin');
    const btnPreviewJunior = document.getElementById('btnPreviewJunior');

        const btnPreviewJuniorCreate = document.getElementById('btnPreviewJuniorCreate');
    const startCreateJunior = document.getElementById('startCreateJunior');
// Seletor de tipo de conta (Cliente / Editor) dentro do modal
    const rolePicker = document.getElementById('rolePicker');
    const roleBtns = rolePicker ? Array.from(rolePicker.querySelectorAll('.roleBtn')) : [];

    function syncRolePickerVisibility(){
      if(!rolePicker) return;
      // só aparece no cadastro (não muda nada no login)
      rolePicker.style.display = 'flex';
    }

    function parseDateFlexible(v){
      if(!v) return null;
      // yyyy-mm-dd
      if(/^\d{4}-\d{2}-\d{2}$/.test(v)){
        const [y,m,d]=v.split('-').map(Number);
        return new Date(y, m-1, d);
      }
      // dd/mm/yyyy
      if(/^\d{2}\/\d{2}\/\d{4}$/.test(v)){
        const [d,m,y]=v.split('/').map(Number);
        return new Date(y, m-1, d);
      }
      const dt = new Date(v);
      return isNaN(dt.getTime()) ? null : dt;
    }

    function calcAge(dob){
      if(!dob) return null;
      const now = new Date();
      let age = now.getFullYear() - dob.getFullYear();
      const m = now.getMonth() - dob.getMonth();
      if(m < 0 || (m === 0 && now.getDate() < dob.getDate())) age--;
      return age;
    }

    function getActiveRole(){
      // Prefer active pill
      const active = document.querySelector('.rolePill.active');
      if(active && active.dataset && active.dataset.role) return active.dataset.role;
      // Fallback: hidden input
      const inp = document.getElementById('authRole');
      if(inp && inp.value) return inp.value;
      // Fallback: global startRole if exists
      try{ if(typeof startRole !== 'undefined' && startRole) return startRole; }catch(e){}
      return 'client';
    }

    function updateMinorEditorUI(){
  // Reaproveitado: agora é apenas um aviso/bloqueio de idade mínima (16+)
  const box = document.getElementById('minorEditorBox');
  if(!box) return;

  // Mostrar apenas no cadastro
  try{
    if(typeof authMode !== 'undefined' && authMode !== 'register'){
      box.style.display = 'none';
      return;
    }
  }catch(e){}

  const inDataEl = document.getElementById('inData');
  const dob = (typeof parseDateFlexible === 'function') ? parseDateFlexible(inDataEl ? inDataEl.value : '') : null;
  const age = (typeof calcAge === 'function') ? calcAge(dob) : null;

  const label = document.getElementById('minorAgeLabel');
  if(label){
    if(age == null) label.innerHTML = 'Para criar conta no Karameloo, você precisa ter <strong>16 anos ou mais</strong>.';
    else if(age < 16) label.innerHTML = `Você tem <strong>${age} anos</strong>. Para criar conta, você precisa ter <strong>16+</strong>.`;
    else label.innerHTML = `Você tem <strong>${age} anos</strong>. ✅ Você atende ao requisito mínimo (16+).`;
  }

  const show = (age != null && age < 16);
  box.style.display = show ? '' : 'none';
}

    function setRole(newRole){
      if(!newRole) return;
      role = newRole;
      roleBtns.forEach(b=> b.classList.toggle('active', (b.dataset.role === role)));
      updateAuthTitle();
      updateMinorEditorUI();
    }

    roleBtns.forEach(b=> b.addEventListener('click', ()=> setRole(b.dataset.role)));

    const inData = document.getElementById('inData');
    if(inData){ inData.addEventListener('input', updateMinorEditorUI); inData.addEventListener('change', updateMinorEditorUI); }
    const inCPF = document.getElementById('inCPF');
    const inEmail = document.getElementById('inEmail');
    const inSenha = document.getElementById('inSenha');
    const inSenha2 = document.getElementById('inSenha2');

    const loginEmail = document.getElementById('loginEmail');
    const loginSenha = document.getElementById('loginSenha');

    var authMode = 'register';

    function updateAuthTitle(){
      // título simples (sem "como Cliente/Editor")
      titleCadastro.textContent = (authMode === 'register') ? 'Criar conta' : 'Fazer login';
    }

    // garante que o conteúdo do cadastro/login não fique “cortado” (PC e celular)
    function syncAuthWrapHeight(){
      if(!authWrap) return;
      const active = (authMode === 'register') ? viewRegister : viewLogin;
      if(!active) return;
      authWrap.style.height = `${active.scrollHeight}px`;
    }

    let switchingAuth = false;

    function setAuthMode(mode, animate=true){
      if(!authWrap || mode === authMode || switchingAuth) return;

      const from = (authMode === 'register') ? viewRegister : viewLogin;
      const to   = (mode === 'register') ? viewRegister : viewLogin;
      if(!from || !to) { authMode = mode; updateAuthTitle(); return; }

      switchingAuth = true;

      // limpa classes de animação anteriores
      [from, to].forEach(el=>{
        el.classList.remove('enterLeft','enterRight','leaveLeft','leaveRight','enter-left','enter-right','leave-left','leave-right');
        el.style.zIndex = '';
      });

      // ativa destino e garante stacking correto
      to.classList.add('active');
      to.style.zIndex = '3';
      from.style.zIndex = '2';

      if(!animate){
        from.classList.remove('active');
        authMode = mode;
        updateAuthTitle();
        syncAuthWrapHeight();
        switchingAuth = false;
        return;
      }

      const toLoginDir = (mode === 'login');

      // força reflow pra animação NÃO “pular”
      void to.offsetWidth;

      requestAnimationFrame(()=>{
        // usa os nomes novos (Left/Right) mas também funciona com CSS anterior
        from.classList.add(toLoginDir ? 'leaveLeft' : 'leaveRight');
        to.classList.add(toLoginDir ? 'enterRight' : 'enterLeft');
      });

      authMode = mode;
      updateAuthTitle();
      syncRolePickerVisibility();

      setTimeout(()=>{
        from.classList.remove('active','leaveLeft','leaveRight');
        to.classList.remove('enterLeft','enterRight');
        from.style.zIndex = '';
        to.style.zIndex = '';
        syncAuthWrapHeight();
        switchingAuth = false;
      }, 380);
    }

    function resetAuthUI(){
      switchingAuth = false;
      authMode = 'register';

      viewRegister?.classList.add('active');
      viewLogin?.classList.remove('active');

      [viewRegister, viewLogin].forEach(el=>{
        el?.classList.remove('enterLeft','enterRight','leaveLeft','leaveRight','enter-left','enter-right','leave-left','leave-right');
        if(el) el.style.zIndex = '';
      });

      updateAuthTitle();
      syncRolePickerVisibility();
      // garante destaque correto no seletor
      if(role){ roleBtns?.forEach(b=> b.classList.toggle('active', (b.dataset.role === role))); }
      syncAuthWrapHeight();
    }

    toLogin?.addEventListener('click', ()=>{ closeCadastro(); setTimeout(()=>{ try{ document.getElementById('startEmail')?.focus(); }catch(e){} }, 50); });
    toRegister?.addEventListener('click', ()=> setAuthMode('register', true));

    // Preview de menor desativado (site 16+)
    function openJuniorPreview(){
      alert('Esta visualização de menor foi desativada. Idade mínima: 16 anos.');
      return;
    }

    // Função legada (mantida para evitar erros)
    function __openJuniorPreviewLegacy(){
      try{
        openCadastro('editor');
        setAuthMode('register', true);
        if(inData){
          // 15 anos (aprox) para cair em "Júnior"
          const today = new Date();
          const y = today.getFullYear() - 15;
          const m = String(today.getMonth()+1).padStart(2,'0');
          const d = String(today.getDate()).padStart(2,'0');
          inData.value = `${y}-${m}-${d}`;
        }
        updateMinorEditorUI?.();
        const box = document.getElementById('minorEditorBox');
        box?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }catch(e){
        console.warn('Preview menor falhou:', e);
      }
    }
  window.openJuniorPreview = openJuniorPreview;

    btnPreviewJunior?.addEventListener('click', openJuniorPreview);
    btnPreviewJuniorCreate?.addEventListener('click', openJuniorPreview);
    startCreateJunior?.addEventListener('click', openJuniorPreview);

// ===== CPF / Idade (demo) =====
    function cpfDigits(v){ return String(v||'').replace(/\D/g,'').slice(0,11); }
    function formatCPF(d){
      d = cpfDigits(d);
      if(d.length<=3) return d;
      if(d.length<=6) return d.slice(0,3)+'.'+d.slice(3);
      if(d.length<=9) return d.slice(0,3)+'.'+d.slice(3,6)+'.'+d.slice(6);
      return d.slice(0,3)+'.'+d.slice(3,6)+'.'+d.slice(6,9)+'-'+d.slice(9);
    }

    function cepDigits(v){ return String(v||'').replace(/\D/g,'').slice(0,8); }
    function formatCEP(v){
      const d = cepDigits(v);
      if(d.length<=5) return d;
      return d.slice(0,5)+'-'+d.slice(5);
    }

    // formata CEP em tempo real
    const inCEP = document.getElementById('inCEP');
    inCEP?.addEventListener('input', ()=>{ inCEP.value = formatCEP(inCEP.value); });

    // UF sempre em maiúsculo
    const inUF = document.getElementById('inUF');
    inUF?.addEventListener('input', ()=>{
  inUF.value = (inUF.value || '').toUpperCase().replace(/[^A-Z]/g,'').slice(0,2);
});

const inEndereco = document.getElementById('inEndereco');
const inNumero = document.getElementById('inNumero');
const inBairro = document.getElementById('inBairro');
const inCidade = document.getElementById('inCidade');
const inComplemento = document.getElementById('inComplemento');

const btnPreviewMinor = document.getElementById('btnPreviewMinor');

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

// ✅ calcAge robusto: aceita Date ou string ISO (yyyy-mm-dd)
function calcAge(input){
  if(!input) return null;
  let dob = null;
  if(input instanceof Date) dob = input;
  else if(typeof input === 'string'){
    // tenta ISO primeiro
    const d = new Date(input);
    dob = isNaN(d.getTime()) && (typeof parseDateFlexible === 'function') ? parseDateFlexible(input) : d;
  }else{
    try{
      const d = new Date(input);
      dob = isNaN(d.getTime()) ? null : d;
    }catch(e){ dob = null; }
  }
  if(!dob || isNaN(dob.getTime())) return null;

  const now = new Date();
  let age = now.getFullYear() - dob.getFullYear();
  const m = now.getMonth() - dob.getMonth();
  if(m < 0 || (m === 0 && now.getDate() < dob.getDate())) age--;
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

// ===== Navegação (stack) =====
const NAV_STACK = [];
let CURRENT_SCREEN = null;

function _resolveScreen(which){
  if(!which) return null;
  if(typeof which === 'string') return document.getElementById(which);
  return which;
}

function _screenId(el){ return el && el.id ? el.id : ''; }

function showScreen(which, instant=false, opts){
  which = _resolveScreen(which);
  if(!which) return;

  opts = opts || {};
  const fromBack = !!opts.fromBack;
  const noPush = !!opts.noPush;

  // empilha a tela atual (quando não for navegação de volta)
  if(!fromBack && CURRENT_SCREEN && which !== CURRENT_SCREEN){
    NAV_STACK.push(CURRENT_SCREEN);
  }

  // troca
  [screenStart, screenProcurar, screenProcurarEditor, screenClientProfile, screenClient, screenPickEditor, screenEditor, screenAuth].forEach(s => s && s.classList.remove('show'));

  // Header grande só na tela inicial (tira a "marca gigantesca" depois que entra)
  if(siteHeader){
    siteHeader.style.display = (which === screenStart) ? '' : 'none';
  }

  const doShow = ()=>{
    which.classList.add('show');
    window.scrollTo({top:0, behavior: instant ? 'auto' : 'smooth'});
    try{ if(typeof onScreenEnter==='function') onScreenEnter(which); }catch(e){}
  };

  CURRENT_SCREEN = which;

  // estado visual: esconder rodapé na autenticação
  try{ document.body.classList.toggle('inAuth', which === screenAuth); }catch(e){}

    try{
      const s = (typeof getSession==='function') ? getSession() : (window.getSession ? window.getSession() : null);
      const logged = !!(s && s.active && (s.active==='cliente' || s.active==='editor'));
      const pre = (!logged) || (which === screenStart) || (which === screenAuth);
      document.body.classList.toggle('preAuth', pre);
    }catch(e){}
// atualiza URL/voltar do navegador
  const sid = _screenId(which);
  if(!noPush && sid){
    try{
      const st = { screen: sid };
      // usa hash para permitir refresh abrir a mesma tela
      if(fromBack) history.replaceState(st, '', '#' + sid);
      else history.pushState(st, '', '#' + sid);
    }catch(e){}
  }

  if(instant) doShow();
  else setTimeout(doShow, 50);
}

function goBack(){
  // se um overlay legal estiver aberto, fecha primeiro
  if(typeof isLegalOpen === 'function' && isLegalOpen()){
    closeLegal();
    return;
  }
  const prev = NAV_STACK.pop();
  if(prev) showScreen(prev, true, { fromBack:true });
  else showScreen(screenStart, true, { fromBack:true });
}

function goBackTo(target){
  target = _resolveScreen(target);
  if(!target){ goBack(); return; }
  const tid = _screenId(target);
  // pop até achar o target
  while(NAV_STACK.length){
    const prev = NAV_STACK.pop();
    if(prev && _screenId(prev) === tid){
      showScreen(prev, true, { fromBack:true });
      return;
    }
  }
  // se não estava no stack, vai direto
  showScreen(target, true, { fromBack:true });
}

// Hook de entrada de telas (para inicializações específicas)
function onScreenEnter(which){
  try{
    // Inicializa/sincroniza o painel do editor com o Supabase quando disponível
    if(typeof screenEditor !== 'undefined' && which === screenEditor){
      if(typeof supaSyncEditorFromDb === 'function'){
        supaSyncEditorFromDb().catch(()=>{});
      }
    }
  }catch(e){}
}

function goBackStart(){ showScreen(screenStart,true,{fromBack:true}); }
function goStart(){ goBackStart(); }
function goStartInstant(){ showScreen(screenStart,true,{fromBack:true}); }

// Browser back/forward
window.addEventListener('popstate', (ev)=>{
  const sid = ev && ev.state && ev.state.screen ? ev.state.screen : (location.hash ? location.hash.replace('#','') : '');
  if(sid === 'inbox'){ return; }
  const el = sid ? document.getElementById(sid) : null;
  if(el) showScreen(el, true, { fromBack:true, noPush:true });
  else showScreen(screenStart, true, { fromBack:true, noPush:true });
});

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
let PRICE_TIER = (sessionStorage.getItem('karameloo_price_tier') || 'avancado');

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

function updateExtraTierPrices(){
  document.querySelectorAll('.priceTag[data-base]').forEach(el=>{
    const base=parseFloat(el.dataset.base||'0')||0;
    const seed=parseInt(el.dataset.seed||'0',10)||0;
    const p=priceForTier(base, seed);
    el.textContent=brl(p);
  });
}
function setPriceTier(tier){
  PRICE_TIER = (tier === 'iniciante' || tier === 'intermediario' || tier === 'avancado') ? tier : 'avancado';
  sessionStorage.setItem('karameloo_price_tier', PRICE_TIER);
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
  if(typeof updateExtraTierPrices === "function") updateExtraTierPrices();
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
  if(typeof updateExtraTierPrices === 'function') updateExtraTierPrices();
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
          <button class="btn" type="button" onclick="choosePackage(${p.id})">Escolher pacote</button>
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

    const chatOverlay = document.getElementById('chatOverlay');
    const chatModal = document.getElementById('chatModal');
    const chatTitle = document.getElementById('chatTitle');
    const chatAvatar = document.getElementById('chatAvatar');
    const chatAvatarImg = document.getElementById('chatAvatarImg');
    const chatAvatarInitial = document.getElementById('chatAvatarInitial');
    const chatMsgs = document.getElementById('chatMsgs');
    const chatIntro = document.getElementById('chatIntro');
    const chatInput = document.getElementById('chatInput');

    // ===== FIX: garantir que o chat fique preso na VIEWPORT (canto inferior direito) =====
    // Motivo: se o chat ficar dentro de um container com filter/transform/backdrop-filter,
    // o position:fixed pode “virar” relativo ao container e parar de seguir a tela.
    function ensureChatOverlayOnBody(){
      try{
        if(!chatOverlay) return;
        if(chatOverlay.parentElement !== document.body){
          document.body.appendChild(chatOverlay); // move para o final do <body>
        }
        // reforço contra qualquer estilo inline/animacao antiga
        chatOverlay.style.position = 'fixed';
        chatOverlay.style.right = 'calc(env(safe-area-inset-right) + 18px)';
        chatOverlay.style.bottom = 'calc(env(safe-area-inset-bottom) + 18px)';
        chatOverlay.style.left = 'auto';
        chatOverlay.style.top = 'auto';
        chatOverlay.style.transform = 'none';
        chatOverlay.style.margin = '0';
      }catch(e){}
    }
    window.ensureChatOverlayOnBody = ensureChatOverlayOnBody;
    try{ ensureChatOverlayOnBody(); }catch(e){}
    window.addEventListener('resize', ()=>{ try{ ensureChatOverlayOnBody(); }catch(e){} });

    let chatCtx = null; // { peerId, peerName, peerWhats, key }
    const chatContacts = document.getElementById('chatContacts');
    const chatContactsSearch = document.getElementById('chatContactsSearch');
    const chatPeerSub = document.getElementById('chatPeerSub');
    const chatInfoName = document.getElementById('chatInfoName');
    const chatInfoSub = document.getElementById('chatInfoSub');
    const chatInfoRole = document.getElementById('chatInfoRole');
    const chatInfoTags = document.getElementById('chatInfoTags');
    const chatInfoPhone = document.getElementById('chatInfoPhone');
    const chatInfoDone = document.getElementById('chatInfoDone');
    const chatInfoResp = document.getElementById('chatInfoResp');
    const chatInfoRepeat = document.getElementById('chatInfoRepeat');
    const chatInfoDoneBar = document.getElementById('chatInfoDoneBar');
    const chatInfoRespBar = document.getElementById('chatInfoRespBar');
    const chatInfoRepeatBar = document.getElementById('chatInfoRepeatBar');

    let chatContactsCache = [];
    let chatActivePeerId = null;

    function apiBase(){
      const v = (sessionStorage.getItem(LS_API_BASE) || '').trim();
      return v.replace(/\/+$/,'');
    }

    async function apiFetch(path, opts){
      const base = apiBase();
      if(!base) throw new Error('no_api');
      const url = base + path;
      const res = await fetch(url, { headers:{'Content-Type':'application/json'}, ...opts });
      if(!res.ok) throw new Error('api_' + res.status);
      return await res.json();
    }

    async function apiHealth(){
      try{
        await apiFetch('/api/health', { method:'GET' });
        return true;
      }catch(e){
        return false;
      }
    }

    async function apiGetEditors(){
      const data = await apiFetch('/api/editors', { method:'GET' });
      const list = Array.isArray(data?.editors) ? data.editors : (Array.isArray(data) ? data : []);
      return list;
    }


    // Lista editores públicos direto do Supabase (sem precisar de backend /api)
    async function supaGetPublicEditors(){
      if(!(typeof SUPABASE_ENABLED !== 'undefined' && SUPABASE_ENABLED && window.supaClient)) return [];
      try{
        const { data: epRows, error: epErr } = await window.supaClient
          .from('editor_profiles')
          .select('user_id, available, xp, whatsapp, bio, softwares, tags, portfolio_text');
        if(epErr) throw epErr;

        const rows = Array.isArray(epRows) ? epRows : [];
        const ids = rows.map(r=>r.user_id).filter(Boolean);
        if(!ids.length) return [];

        const { data: pRows, error: pErr } = await window.supaClient
          .from('profiles')
          .select('user_id, display_name, role')
          .in('user_id', ids);
        if(pErr) throw pErr;

        const pMap = new Map((pRows||[]).map(p=>[p.user_id, p]));

        // 'editors.is_active' ajuda a esconder clientes (que também têm row em editors)
        let aMap = new Map();
        try{
          const { data: aRows, error: aErr } = await window.supaClient
            .from('editors')
            .select('user_id, is_active')
            .in('user_id', ids);
          if(!aErr && Array.isArray(aRows)){
            aMap = new Map(aRows.map(x=>[x.user_id, x]));
          }
        }catch(e){}

        const list = [];
        rows.forEach((r,i)=>{
          const prof = pMap.get(r.user_id) || {};
          const act = aMap.get(r.user_id);
          const isActive = act ? !!act.is_active : (String(prof.role||'') === 'editor');
          if(!isActive) return;

          list.push(normalizeEditor({
            id: r.user_id,
            name: prof.display_name || 'Editor',
            xp: r.xp || 'iniciante',
            tags: Array.isArray(r.tags)
              ? r.tags
              : (typeof r.tags === 'string' ? r.tags.split(',').map(s=>s.trim()).filter(Boolean) : []),
            available: (r.available != null) ? !!r.available : false,
            whats: r.whatsapp || '',
            bio: r.bio || '',
            soft: r.softwares || '',
            portfolio: r.portfolio_text || '',
            packages: [], // pacotes ainda são locais neste MVP
            stars: START_STARS
          }, 'supa_'+(i+1)));
        });

        return list;
      }catch(e){
        console.warn('[Explore] supaGetPublicEditors falhou:', e);
        return [];
      }
    }

    function getFavIds(){
      const arr = lsGet(LS_FAV_EDITORS, []);
      return new Set(Array.isArray(arr) ? arr : []);
    }

    function setFavIds(setObj){
      lsSet(LS_FAV_EDITORS, Array.from(setObj));
    }

    function toggleFavEditor(id){
      const s = getFavIds();
      if(s.has(id)) s.delete(id);
      else s.add(id);
      setFavIds(s);
    }

    function addRecentEditor(id){
      const arr = lsGet(LS_RECENT_EDITORS, []);
      const list = Array.isArray(arr) ? arr : [];
      const next = [id, ...list.filter(x=>x!==id)].slice(0, 12);
      lsSet(LS_RECENT_EDITORS, next);
    }

    function hasAnyVideoPkg(editor){
      return (editor.packages||[]).some(pid=>{
        const p = packages.find(x=>x.id===pid);
        const n = (p?.name||'').toLowerCase();
        return n.includes('vídeo') || n.includes('video') || n.includes('short');
      });
    }

    function hasAnyFotoPkg(editor){
      return (editor.packages||[]).some(pid=>{
        const p = packages.find(x=>x.id===pid);
        const n = (p?.name||'').toLowerCase();
        return n.includes('foto');
      });
    }

    function normalizeEditor(raw, fallbackId){
      const name = raw?.name || raw?.full || raw?.nome || 'Editor';
      const id = String(raw?.id || raw?.uid || raw?.email || fallbackId || name).replace(/\s+/g,'_');

      // Works/portfólio: pode vir como arrays (URL), ou {photos:[], videos:[]}
      const rawWorks = raw?.works || raw?.trabalhos || raw?.portfolioWorks || null;
      let photos = [];
      let videos = [];
      if(Array.isArray(rawWorks)){
        // se vier só uma lista, assume fotos
        photos = rawWorks.slice(0, 30);
      }else if(rawWorks && typeof rawWorks === 'object'){
        photos = Array.isArray(rawWorks.photos) ? rawWorks.photos.slice(0, 30) : [];
        videos = Array.isArray(rawWorks.videos) ? rawWorks.videos.slice(0, 10) : [];
      }else{
        photos = Array.isArray(raw?.workPhotos) ? raw.workPhotos.slice(0, 30) : [];
        videos = Array.isArray(raw?.workVideos) ? raw.workVideos.slice(0, 10) : [];
      }

      return {
        id,
        name,
        xp: raw?.xp || 'iniciante',
        tags: Array.isArray(raw?.tags) ? raw.tags : (Array.isArray(raw?.skills) ? raw.skills : []),
        packages: Array.isArray(raw?.packages) ? raw.packages.map(n=>Number(n)).filter(Boolean) : [],
        available: !!raw?.available,
        stars: (raw?.stars ?? START_STARS),
        photo: raw?.photo || '',
        bio: raw?.bio || '',
        soft: raw?.soft || raw?.software || '',
        portfolio: raw?.portfolio || raw?.portifolio || raw?.portfolioLink || '',
        whats: raw?.whats || raw?.telefone || raw?.wpp || '',
        cover: raw?.cover || raw?.capa || raw?.bg || raw?.coverImg || raw?.coverImage || '',
        works: { photos, videos }
      };
    }

    function getLocalEditorsFromAccounts(){
      const acc = getAccounts();
      const edMap = acc?.editor || {};
      const list = [];
      Object.keys(edMap).forEach((k, idx)=>{
        const prof = edMap[k]?.profile || edMap[k]?.perfil || edMap[k];
        if(!prof) return;
        const e = normalizeEditor({
          id: 'acc_' + k,
          name: prof.full || prof.name || ('Editor ' + (idx+1)),
          xp: prof.xp,
          tags: prof.tags,
          packages: prof.packages,
          available: prof.available,
          stars: prof.stars,
          photo: prof.photo,
          bio: prof.bio,
          soft: prof.soft,
          whats: prof.whats,
          cover: prof.cover
        }, 'acc_' + k);
        list.push(e);
      });
      return list;
    }

    function getProcurarEditorsLocal(){
      const list = [];

      // editores cadastrados (no mesmo navegador)
      getLocalEditorsFromAccounts().forEach(e=> list.push(e));

      // seu editor (se existir)
      if(editorData && (editorData.full || editorData.first)){
        list.push(normalizeEditor({
          id:'you',
          name: editorData.full || 'Você',
          xp: editorData.xp,
          tags: editorData.tags,
          packages: editorData.packages,
          available: editorData.available,
          stars: editorData.stars,
          photo: editorData.photo,
          bio: editorData.bio,
          soft: editorData.soft,
          portfolio: editorData.portfolio,
          whats: editorData.whats,
          cover: editorData.cover,
          workPhotos: (workPhotos||[]).slice(0, MAX_WORK_PHOTOS),
          workVideos: (workVideos||[]).slice(0, MAX_WORK_VIDEOS)
        }, 'you'));
      }

      // demos
      DEMO_EDITORS.forEach((e, i)=> list.push(normalizeEditor(e, 'demo_'+(i+1))));

      // remove duplicados por id
      const seen = new Set();
      const uniq = [];
      list.forEach(e=>{
        if(seen.has(e.id)) return;
        seen.add(e.id);
        uniq.push(e);
      });
      return uniq;
    }

    async function getProcurarEditors(){
      const base = apiBase();

      // 1) Backend próprio (/api) — se configurado
      if(base){
        const ok = await apiHealth();
        if(ok){
          try{
            const apiEditors = await apiGetEditors();
            const list = apiEditors.map((e,i)=>normalizeEditor(e, 'api_'+(i+1)));
            if(list.length) return list;
          }catch(e){
            // se falhar, cai para Supabase ou local
          }
        }
      }

      // 2) Supabase direto (quando não há backend /api)
      if(typeof SUPABASE_ENABLED !== 'undefined' && SUPABASE_ENABLED && window.supaClient){
        const supaEditors = await supaGetPublicEditors();
        if(supaEditors && supaEditors.length) return supaEditors;
      }

      // 3) Fallback demo/local
      return getProcurarEditorsLocal();
    }

    function editorMatchesSearch(e, q){
      if(!q) return true;
      const hay = [e.name, e.xp, e.soft, e.bio, (e.tags||[]).join(' ')].join(' ').toLowerCase();
      return hay.includes(q);
    }

    function editorMatchesFilter(e){
      const f = exploreFilter;
      const fav = getFavIds();
      if(f==='fav') return fav.has(e.id);
      if(f==='video') return hasAnyVideoPkg(e) || (e.tags||[]).join(' ').toLowerCase().includes('vídeo');
      if(f==='foto') return hasAnyFotoPkg(e) || (e.tags||[]).join(' ').toLowerCase().includes('foto');
      if(f==='audio') return (e.tags||[]).join(' ').toLowerCase().includes('áudio') || (e.tags||[]).join(' ').toLowerCase().includes('audio');
      if(f==='legenda') return (e.tags||[]).join(' ').toLowerCase().includes('legenda');
      if(f==='motion') return (e.tags||[]).join(' ').toLowerCase().includes('motion');
      if(f==='premium') return (Number(e.stars||START_STARS) >= 8) || (e.packages||[]).length >= 8 || (String(e.xp||'').toLowerCase()==='avancado');
      return true;
    }

    function sortEditors(arr, mode){
      const rank = { avancado:3, intermediario:2, iniciante:1 };
      if(mode==='fast') return arr.sort((a,b)=>(rank[b.xp]||1)-(rank[a.xp]||1));
      if(mode==='pkgs') return arr.sort((a,b)=>(b.packages?.length||0)-(a.packages?.length||0));
      if(mode==='new') return arr.sort((a,b)=>String(b.id).localeCompare(String(a.id)));
      // best
      return arr.sort((a,b)=>(Number(b.stars||START_STARS))-(Number(a.stars||START_STARS)));
    }

    function updateProcurarHeader(){
      const logged = isClientLogged();
      if(btnProcurarProfile) btnProcurarProfile.style.display = logged ? '' : 'none';

      if(exploreSubtitle){
        exploreSubtitle.textContent = logged
          ? `Bem-vindo, ${clientData?.first || clientData?.full || 'Cliente'} — escolha um editor e veja os pacotes dele.`
          : 'Descubra perfis, compare estilos e salve seus favoritos.';
      }

      if(exploreAvatar){
        const letter = (clientData?.full||'K')[0];
        setAvatar(exploreAvatar, logged ? (clientData?.photo||'') : '', letter);
      }

      if(exploreBackendStatus){
        const base = apiBase();
        if(base){
          exploreBackendStatus.textContent = `Backend conectado: ${base}`;
        }else if(typeof SUPABASE_ENABLED !== 'undefined' && SUPABASE_ENABLED && window.supaClient){
          exploreBackendStatus.textContent = 'Supabase conectado.';
        }else{
          exploreBackendStatus.textContent = 'Modo demo/local (sem backend).';
        }
        exploreBackendStatus.style.opacity = '.9';
      }
    }

    function requestChatWithEditor(editorId){
      const id = String(editorId||'');
      if(!id) return;
      if(!isClientLogged()){
        setPostLoginIntent({ type:'chat', editorId:id });
        openCadastro('cliente');
        return;
      }
      openChatWithEditor(id);
    }

    function renderEditorCard(e){

      const fav = getFavIds();
      const isFav = fav.has(e.id);
      const tags = (e.tags||[]).slice(0,6);
      const statusBadge = e.available
        ? `<span class="badge you">Disponível</span>`
        : `<span class="badge off">Off</span>`;

      const btnProfile = `<button class="btn" type="button" onclick="openEditorProfileTab('${escapeHtml(e.id)}')">Ver perfil</button>`;

      const btnPrimary = `<button class="btn" type="button" onclick="requestChatWithEditor('${escapeHtml(e.id)}')">💬 Falar com o editor</button>`;

      const btnSecondary = `<button class="btn secondary" type="button" onclick="toggleProcurarFav('${escapeHtml(e.id)}')">${isFav ? '★ Salvo' : '☆ Salvar'}</button>`;

      return `
        <div class="eThumb" style="background-image: var(--thumb, none)"></div>
        <div class="eTop">
          <div style="display:flex; gap:10px; align-items:center;">
            <div class="avatar" style="width:46px;height:46px" id="exAv_${escapeHtml(e.id)}">${escapeHtml((e.name||'E')[0])}</div>
            <div>
              <div class="eName">${escapeHtml(e.name)}</div>
              <div class="stars" style="margin-top:4px">${renderStarsHTML(e.stars ?? START_STARS, MAX_STARS)}</div>
              <div class="eMeta">${escapeHtml(e.xp)} • Pacotes: ${e.packages?.length||0}</div>
            </div>
          </div>
          <div style="text-align:right">${statusBadge}</div>
        </div>
        <div class="eBio">${escapeHtml(e.bio || (tags.length ? tags.join(' • ') : 'Editor com estilo premium.'))}</div>
        <div class="eBadges">
          ${tags.map(t=>`<span class="badge pillBlue">${escapeHtml(t)}</span>`).join('') || `<span class="badge off">Sem tags</span>`}
        </div>
        <div class="eActions">
          ${btnProfile}
          ${btnPrimary}
          ${btnSecondary}
        </div>
      `;
    }

    function renderProcurarCarousel(list){
      if(!exploreEditorsCarousel) return;
      exploreEditorsCarousel.innerHTML = '';
      const top = (list || []).slice(0, 10);

      top.forEach(e=>{
        const id = String(e.id);
        const nm = escapeHtml(e.name || 'Editor');
        const initials = escapeHtml((e.name||'E')[0]);
        const mt = escapeHtml(((e.tags||[]).slice(0,2).join(' • ')) || e.xp || 'Editor premium');
        const rating = Math.round((Number(e.stars ?? START_STARS))*10)/10;

        const card = document.createElement('div');
        card.className = 'miniGig';
        const mth = (e.cover && e.cover.img) ? `url(${e.cover.img})` : (e.cover && e.cover.preset && e.cover.preset!=='none' ? presetToCover(e.cover.preset) : '');
        if(mth) card.style.setProperty('--miniThumb', mth);
        card.innerHTML = `
          <div class="thumb" style="background-image: var(--miniThumb, none)"></div>
          <div class="info">
            <div class="whoMini">
              <div class="avMini" id="miniAv_${id}">${initials}</div>
              <div>
                <div class="nm">${nm}</div>
                <div class="mt">${mt}</div>
              </div>
            </div>
            <div style="font-weight:1000; color:rgba(255,224,138,.95)">${rating}</div>
          </div>`;

        card.addEventListener('click', ()=>{ openEditorProfileTab(id); });
        exploreEditorsCarousel.appendChild(card);
        const av = document.getElementById(`miniAv_${id}`);
        if(av) setAvatar(av, e.photo || '', (e.name||'E')[0]);
      });
    }

    async function renderProcurarEditors(){
      if(!exploreEditorsGrid) return;
      updateProcurarHeader();

      const q = (exploreSearch?.value || '').trim().toLowerCase();
      const sort = exploreSort?.value || 'best';

      const all = await getProcurarEditors();
      exploreEditorsCache = all.slice();
      exploreEditorsById = {};
      exploreEditorsCache.forEach(e=>{ exploreEditorsById[e.id] = e; });

      try{ window.EDITORS_DB = exploreEditorsCache; }catch(e){}
let arr = all.slice();

      // sempre mostra OFF também, mas joga pro final
      arr = arr.filter(e => editorMatchesFilter(e) && editorMatchesSearch(e, q));
      arr = sortEditors(arr, sort);
      arr.sort((a,b)=> (b.available===a.available)?0:(b.available? -1: 1));

      renderProcurarCarousel(arr);

      exploreEditorsGrid.innerHTML = '';
      if(!arr.length){
        exploreEditorsGrid.innerHTML = `
          <div class="card full" style="grid-column:1/-1">
            <h3>Nenhum editor encontrado</h3>
            <p>Tente outra busca ou filtre por “Todos”.</p>
          </div>`;
        return;
      }

      arr.forEach(e=>{
        const card = document.createElement('div');
        card.className = 'eCard';
        const th = (e.cover && e.cover.img) ? `url(${e.cover.img})` : (e.cover && e.cover.preset && e.cover.preset!=='none' ? presetToCover(e.cover.preset) : '');
        if(th) card.style.setProperty('--thumb', th);
        card.innerHTML = renderEditorCard(e);
        exploreEditorsGrid.appendChild(card);
        const av = document.getElementById(`exAv_${e.id}`);
        if(av) setAvatar(av, e.photo || '', (e.name||'E')[0]);
      });

      // ativa chip selecionado
      const row = document.querySelector('.chipsRow');
      row?.querySelectorAll('.chipBtn').forEach(b=>{
        const f = b.getAttribute('data-filter') || 'all';
        b.classList.toggle('active', f === exploreFilter);
      });

      // sincroniza categorias do topo
      if(marketCats){
        marketCats.querySelectorAll('.catBtn').forEach(b=>{
          const f = b.getAttribute('data-filter') || 'all';
          b.classList.toggle('active', f === exploreFilter);
        });
      }

      if(exploreHint){
        exploreHint.textContent = isClientLogged()
          ? 'Dica: abra o perfil do editor e clique em “Ver pacotes deste editor”.'
          : 'Dica: você pode procurar — para contratar, crie uma conta de cliente (ou fale com o editor e crie na hora).';
      }
    }

    function goProcurar(instant=false){
      if(instant){
        showScreen(screenProcurar, true);
        requestAnimationFrame(()=>{ try{ renderProcurarEditors(); }catch(e){} });
      }else{
        renderProcurarEditors();
        showScreen(screenProcurar, false);
      }
    }

    function goProcurarEditor(instant=false){
      if(!editorData) editorData = buildEditorDefaults();
      if(exploreEWelcomeName) exploreEWelcomeName.textContent = (editorData.full || editorData.first || 'Editor');
      if(exploreESubtitle){
        exploreESubtitle.textContent = 'Encontre clientes compatíveis com seus pacotes e envie uma proposta (demo).';
      }
      if(instant){
        showScreen(screenProcurarEditor, true);
        requestAnimationFrame(()=>{ try{ renderProcurarClients(); }catch(e){} });
      }else{
        renderProcurarClients();
        showScreen(screenProcurarEditor, false);
      }
    }

    function goEditorDashboard(){
      if(!editorData) editorData = buildEditorDefaults();
      paintEditor();
      showScreen(screenEditor);
    }

    function scrollToProcurarClientsGrid(){
      const el = document.getElementById('exploreClientsGridAnchor');
      el?.scrollIntoView({behavior:'smooth', block:'start'});
    }

    function getFavClientIds(){
      const arr = lsGet(LS_FAV_CLIENTS, []);
      return new Set(Array.isArray(arr) ? arr : []);
    }
    function setFavClientIds(setObj){ lsSet(LS_FAV_CLIENTS, Array.from(setObj)); }
    function toggleFavClient(id){
      const s = getFavClientIds();
      if(s.has(id)) s.delete(id); else s.add(id);
      setFavClientIds(s);
    }

    function normalizeClient(raw, fallbackId){
      const name = raw?.name || raw?.full || raw?.nome || 'Cliente';
      const id = String(raw?.id || raw?.uid || raw?.email || fallbackId || name).replace(/\s+/g,'_');
      const niche = raw?.niche || raw?.categoria || '';
      const about = raw?.about || raw?.bio || raw?.descricao || '';
      const city = raw?.city || raw?.cidade || '';
      const platform = raw?.mainPlatform || raw?.plataforma || raw?.platform || '';
      const whats = raw?.whats || raw?.telefone || '';
      const tags = [];
      if(niche) tags.push(niche);
      if(platform) tags.push(platform);
      const txt = (niche + ' ' + about).toLowerCase();
      if(txt.includes('reels') || txt.includes('tiktok') || txt.includes('short')) tags.push('reels');
      if(txt.includes('foto')) tags.push('foto');
      if(txt.includes('áudio') || txt.includes('audio') || txt.includes('ruído') || txt.includes('ruido')) tags.push('audio');
      if(txt.includes('legenda')) tags.push('legenda');
      if(txt.includes('motion')) tags.push('motion');
      const urgent = txt.includes('urgente') || txt.includes('hoje') || txt.includes('rápido') || txt.includes('rapido');
      return { id, name, niche, about, city, platform, whats, tags, urgent };
    }

    function getLocalClientsFromAccounts(){
      const acc = getAccounts();
      const clMap = acc?.client || {};
      const list = [];
      Object.keys(clMap).forEach((k, idx)=>{
        const prof = clMap[k]?.profile || clMap[k]?.perfil || clMap[k];
        if(!prof) return;
        const c = normalizeClient({
          id: 'acc_' + k,
          name: prof.full || prof.name || ('Cliente ' + (idx+1)),
          niche: prof.niche,
          about: prof.about,
          city: prof.city,
          mainPlatform: prof.mainPlatform,
          whats: prof.whats,
          cover: prof.cover
        }, 'acc_' + k);
        list.push(c);
      });
      return list;
    }

    const DEMO_CLIENTS = [
      {id:'c1', name:'Loja de Roupas', niche:'Moda', mainPlatform:'instagram', about:'Preciso de 6 Reels por semana (cortes rápidos, cor cine).', whats:''},
      {id:'c2', name:'Personal Trainer', niche:'Fitness', mainPlatform:'tiktok', about:'Vídeos curtos com legendas e limpeza de áudio. Prazo rápido.', whats:''},
      {id:'c3', name:'Canal de Gameplay', niche:'Gaming', mainPlatform:'youtube', about:'Highlights com motion simples, zoom, SFX e ritmo.', whats:''},
      {id:'c4', name:'Imobiliária', niche:'Negócios', mainPlatform:'instagram', about:'Edição de fotos + reels de imóveis com áudio limpo e cor.', whats:''},
    ];

    function getProcurarClientsLocal(){
      const list = [];
      getLocalClientsFromAccounts().forEach(c=>list.push(c));
      if(clientData && (clientData.full || clientData.first)){
        list.push(normalizeClient({
          id:'you_client',
          name: clientData.full || 'Você',
          niche: clientData.niche,
          about: clientData.about,
          city: clientData.city,
          mainPlatform: clientData.mainPlatform,
          whats: clientData.whats
        }, 'you_client'));
      }
      DEMO_CLIENTS.forEach((c,i)=> list.push(normalizeClient(c,'demo_c_'+(i+1))));
      // uniq
      const seen = new Set();
      const uniq = [];
      list.forEach(c=>{ if(seen.has(c.id)) return; seen.add(c.id); uniq.push(c); });
      return uniq;
    }

    function clientMatchesFilter(c){
      if(exploreEFilter==='all') return true;
      if(exploreEFilter==='urg') return !!c.urgent;
      if(exploreEFilter==='fav') return getFavClientIds().has(String(c.id));
      return (c.tags||[]).some(t=> String(t).toLowerCase().includes(exploreEFilter));
    }
    function clientMatchesSearch(c, q){
      if(!q) return true;
      const hay = `${c.name} ${c.niche} ${c.about} ${c.city} ${c.platform}`.toLowerCase();
      return hay.includes(q);
    }
    function sortClients(arr, sort){
      const a = arr.slice();
      if(sort==='urg') a.sort((x,y)=> (y.urgent===x.urgent)?0:(y.urgent?1:-1));
      else if(sort==='new') a.sort((x,y)=> String(y.id).localeCompare(String(x.id)));
      else if(sort==='fit') a.sort((x,y)=> (y.tags?.length||0) - (x.tags?.length||0));
      return a;
    }

    function renderClientCard(c){
      const fav = getFavClientIds();
      const isFav = fav.has(String(c.id));
      const badges = (c.tags||[]).slice(0,6).map(t=>`<span class="badge">${escapeHtml(t)}</span>`).join('') || `<span class="badge off">Sem tags</span>`;
      const meta = [c.niche, c.city].filter(Boolean).join(' • ');
      return `
        <div class="eThumb"></div>
        <div class="eTop">
          <div class="eName">${escapeHtml(c.name)}</div>
          <div class="pill" style="margin:0">${c.urgent ? 'Urgente' : 'Pedido'}</div>
        </div>
        <div class="eSub">${escapeHtml(meta || 'Cliente (demo)')}</div>
        <div class="eBadges" style="margin-top:10px">${badges}</div>
        <div class="hint" style="margin-top:10px">${escapeHtml((c.about||'').slice(0,120) + ((c.about||'').length>120?'…':''))}</div>
        <div class="eActions">
          <button class="btn" type="button" onclick="openClientBriefing('${escapeHtml(c.id)}')">Ver briefing</button>
          <button class="btn secondary" type="button" onclick="toggleProcurarClientFav('${escapeHtml(c.id)}')">${isFav ? '★ Salvo' : '☆ Salvar'}</button>
        </div>
      `;
    }

    function toggleProcurarClientFav(id){
      toggleFavClient(String(id));
      renderProcurarClients();
    }

    let exploreClientsById = {};
    function renderProcurarClients(){
      const q = String(exploreESearch?.value||'').trim().toLowerCase();
      const sort = String(exploreESort?.value||'best');
      let arr = getProcurarClientsLocal().filter(c=> clientMatchesFilter(c) && clientMatchesSearch(c,q));
      arr = sortClients(arr, sort);

      exploreClientsById = {};
      arr.forEach(c=> exploreClientsById[c.id]=c);

      // carousel
      if(exploreClientsCarousel){
        exploreClientsCarousel.innerHTML = '';
        arr.slice(0,8).forEach(c=>{
          const d = document.createElement('div');
          d.className = 'carItem';
          d.innerHTML = `<div class="carTitle">${escapeHtml(c.name)}</div><div class="carSub">${escapeHtml(c.niche || 'Pedido')}</div>`;
          d.addEventListener('click', ()=> openClientBriefing(c.id));
          exploreClientsCarousel.appendChild(d);
        });
      }

      if(exploreClientsGrid){
        exploreClientsGrid.innerHTML = '';
        if(!arr.length){
          exploreClientsGrid.innerHTML = `<div class="card full" style="grid-column:1/-1"><h3>Nenhum cliente encontrado</h3><p>Tente outra busca ou troque os filtros.</p></div>`;
        }else{
          arr.forEach(c=>{
            const card = document.createElement('div');
            card.className = 'eCard';
            card.innerHTML = renderClientCard(c);
            exploreClientsGrid.appendChild(card);
          });
        }
      }

      if(exploreEHint){
        exploreEHint.textContent = 'Dica: abra o briefing e combine pelo Telefone (se o cliente tiver informado).';
      }
    }

    function openClientBriefing(id){
      const c = exploreClientsById?.[id];
      if(!c) return;
      const txt = `Cliente: ${c.name}\nNicho: ${c.niche||'-'}\nCidade: ${c.city||'-'}\nPlataforma: ${c.platform||'-'}\n\nBriefing:\n${c.about||'(não informado)'}\n\n(OK = abrir Telefone se existir / Cancelar = fechar)`;
      const ok = confirm(txt);
      if(!ok) return;
      const d = String(c.whats||'').replace(/\D/g,'');
      if(!d){
        alert('Este cliente ainda não informou Telefone. (demo)');
        return;
      }
      const br = (d.length===10 || d.length===11) ? ('55'+d) : d;
      const msg = encodeURIComponent('Olá! Vi seu pedido no Karameloo. Posso te ajudar com a edição?');
      try{ navigator.clipboard?.writeText(msg); }catch(e){}
      // Abre no discador do telefone (sem nova guia)
      window.location.href = `tel:${br}`;
    }

    function goClientProfileFromProcurar(){
      if(!clientData) clientData = buildClientDefaults();
      paintClientProfile();
      if(typeof syncClientCoverControls==='function') syncClientCoverControls();
      showScreen(screenClientProfile);
    }

    function openProcurarApiConfig(){
      // Modo demo: sem backend configurado (evita pop-up chato)
      sessionStorage.setItem(LS_API_BASE, '');
      showToast('Modo demo: backend ainda não conectado. Usando modo LocalStorage.');
      renderProcurarEditors();
    }

    function scrollToProcurarGrid(){
      const el = document.getElementById('exploreGridAnchor');
      el?.scrollIntoView({behavior:'smooth', block:'start'});
    }

    function startBriefing(){
      // pode ver pacotes sem conta; contratar pede conta
      if(!clientData) clientData = buildClientDefaults();
      // se ainda nao completou o perfil, vai para o perfil primeiro
      if(!clientData) clientData = buildClientDefaults();
      const hasProfile = !!(clientData?.whats || clientData?.city || clientData?.niche || clientData?.about);
      if(!hasProfile){
        paintClientProfile();
        showScreen(screenClientProfile);
        return;
      }
      // vai para pacotes e rola direto no personalizado
      paintClientTop();
      showScreen(screenClient);
      setTimeout(()=>{
        const h = document.querySelector('#screenClient .card.highlight');
        h?.scrollIntoView({behavior:'smooth', block:'start'});
      }, 80);
    }
function toggleProcurarFav(id){
      toggleFavEditor(String(id));
      renderProcurarEditors();
    }

    function openEditorProfile(id, mode='modal'){
      mode = (mode==='page' || mode==='modal') ? mode : 'modal';
      const e = exploreEditorsById?.[id];
      if(!e) return;
      addRecentEditor(e.id);

      const xpLabel = (String(e.xp||'').toLowerCase()==='avancado') ? 'Avançado'
                    : (String(e.xp||'').toLowerCase()==='intermediario') ? 'Intermediário'
                    : (String(e.xp||'').toLowerCase()==='iniciante') ? 'Iniciante'
                    : (e.xp || 'Nível');

      if(profileTitle) profileTitle.textContent = `Perfil: ${e.name}`;

      const tags = (e.tags||[]).slice(0, 20);
      const pkgs = (e.packages||[]);
      const fav = getFavIds();
      const isFav = fav.has(e.id);

      const works = e.works || {photos:[], videos:[]};
      const photos = Array.isArray(works.photos) ? works.photos : [];
      const videos = Array.isArray(works.videos) ? works.videos : [];
      const totalWorks = photos.length + videos.length;

      const pkgBadges = pkgs.map(pid=>{
        const p = packages.find(x=>x.id===pid);
        return p ? `<span class="badge pillBlue">${escapeHtml(p.name)}</span>` : '';
      }).join('');

      const tagBadges = tags.length
        ? tags.map(t=>`<span class="badge">${escapeHtml(t)}</span>`).join('')
        : `<span class="badge off">Sem tags</span>`;

      const safeLink = (url)=>{
        const u = String(url||'').trim();
        if(!u) return '';
        if(/^https?:\/\//i.test(u)) return u;
        // permite "www." sem protocolo
        if(/^www\./i.test(u)) return 'https://' + u;
        return '';
      };
      const portfolioLink = safeLink(e.portfolio || '');

      const worksHtml = totalWorks ? `
        <div class="proWorkGrid">
          ${photos.map((url, i)=>`
            <button class="workTile" type="button" onclick="openWorkLightbox('${escapeHtml(url)}','photo')" aria-label="Abrir trabalho (foto ${i+1})">
              <img src="${escapeHtml(url)}" loading="lazy" alt="Trabalho do editor (foto ${i+1})" />
              <span class="workTag">Foto</span>
            </button>
          `).join('')}
          ${videos.map((url, i)=>`
            <button class="workTile video" type="button" onclick="openWorkLightbox('${escapeHtml(url)}','video')" aria-label="Abrir trabalho (vídeo ${i+1})">
              <div class="videoPh">
                <span class="playIcon">▶</span>
                <span class="workTag">Vídeo</span>
              </div>
            </button>
          `).join('')}
        </div>
        <div class="hint" style="margin-top:10px">Dica: clique em um trabalho para ver em tela grande.</div>
      ` : `
        <div class="emptyPro">
          <div class="emptyTitle">Nenhum trabalho enviado ainda</div>
          <div class="emptySub">Quando o editor adicionar trabalhos no painel, eles aparecem aqui para o cliente.</div>
        </div>
      `;

      const _target = (mode==='page') ? document.getElementById('profilePageBody') : profileBody;
      if(_target){
        _target.innerHTML = `
          <div class="proProfileHero" style="${e.cover ? `background-image:url('${escapeHtml(e.cover)}')` : ''}">
            <div class="proHeroOverlay"></div>
            <div class="proHeroInner">
              <div class="proTopRow">
                <div class="avatar big" id="profileAv" style="width:74px;height:74px"></div>
                <div class="proMeta">
                  <div class="proNameRow">
                    <div class="proName">${escapeHtml(e.name)}</div>
                    <span class="proStatus ${e.available ? 'on' : 'off'}">${e.available ? 'Disponível' : 'Off'}</span>
                  </div>
                  <div class="proMiniRow">
                    <span class="proPill">${escapeHtml(xpLabel)}</span>
                    <span class="proPill">⭐ ${Number(e.stars ?? START_STARS).toFixed(1)}/10</span>
                    <span class="proPill">${(e.packages?.length||0)} pacotes</span>
                    <span class="proPill">${totalWorks} trabalhos</span>
                  </div>
                  <div class="proStarsRow">
                    <div class="stars">${renderStarsHTML(e.stars ?? START_STARS, MAX_STARS)}</div>
                  </div>
                </div>
              </div>
              <div class="proTopActions">
                <button class="btn secondary small" type="button" onclick="toggleProcurarFav('${escapeHtml(e.id)}')">${isFav ? '★ Salvo' : '☆ Salvar'}</button>
                <button class="btn secondary small" type="button" onclick="requestChatWithEditor('${escapeHtml(e.id)}')">💬 Falar</button>
                <button class="btn small" type="button" onclick="openEditorShop('${escapeHtml(e.id)}')">Ver pacotes</button>
              </div>
            </div>
          </div>

          <div class="proGrid">
            <div class="proCol">
              <div class="card proCard" style="padding:14px">
                <h3 style="margin:0 0 8px">Sobre</h3>
                <p style="margin:0; color:rgba(229,231,235,.78)">${escapeHtml(e.bio || 'Bio não informada.')}</p>
                <div class="eBadges" style="margin-top:12px">${tagBadges}</div>
              </div>

              <div class="card proCard" style="padding:14px; margin-top:12px">
                <h3 style="margin:0 0 8px">Ferramentas e links</h3>
                <div class="proInfoList">
                  <div class="proInfoRow">
                    <span class="k">Softwares</span>
                    <span class="v">${escapeHtml(e.soft || 'Não informado')}</span>
                  </div>
                  <div class="proInfoRow">
                    <span class="k">Portfólio</span>
                    <span class="v">${portfolioLink ? `<a class="proLink" href="${escapeHtml(portfolioLink)}" target="_blank" rel="noopener">Abrir link</a>` : 'Não informado'}</span>
                  </div>
                  <div class="proInfoRow">
                    <span class="k">Telefone</span>
                    <span class="v">${e.whats ? `<button class="btn secondary small" type="button" onclick="copyText('${escapeHtml(e.whats)}')">Copiar</button>` : 'Não informado'}</span>
                  </div>
                </div>
              </div>

              <div class="card proCard" style="padding:14px; margin-top:12px">
                <h3 style="margin:0 0 8px">Por que contratar</h3>
                <div class="proHighlights">
                  <div class="hi">
                    <div class="hiT">Comunicação rápida</div>
                    <div class="hiS">Chat direto e objetivo</div>
                  </div>
                  <div class="hi">
                    <div class="hiT">Entrega consistente</div>
                    <div class="hiS">Padrão de qualidade do Karameloo</div>
                  </div>
                  <div class="hi">
                    <div class="hiT">Ajustes finos</div>
                    <div class="hiS">Detalhes que melhoram retenção</div>
                  </div>
                </div>
              </div>
            </div>

            <div class="proCol">
              <div class="card proCard" style="padding:14px">
                <div class="proSecTop">
                  <h3 style="margin:0">Trabalhos</h3>
                  <span class="badge">${totalWorks} itens</span>
                </div>
                ${worksHtml}
              </div>

              <div class="card proCard" style="padding:14px; margin-top:12px">
                <h3 style="margin:0 0 8px">Pacotes aceitos</h3>
                <div class="eBadges">${pkgBadges || `<span class="badge off">Nenhum pacote selecionado</span>`}</div>
                <div class="hint" style="margin-top:10px">* Demo: o editor precisa marcar pacotes e ficar “Disponível”.</div>
              </div>

              <div class="proFooterActions">
                <button class="btn" type="button" onclick="openEditorShop('${escapeHtml(e.id)}')">Ver pacotes deste editor</button>
                <button class="btn secondary" type="button" onclick="requestChatWithEditor('${escapeHtml(e.id)}')">💬 Falar com o editor</button>
                <button class="btn secondary" type="button" onclick="toggleProcurarFav('${escapeHtml(e.id)}')">${isFav ? '★ Remover dos salvos' : '☆ Salvar editor'}</button>
                <button class="btn secondary" type="button" onclick="closeEditorProfile()">✕</button>
              </div>
            </div>
          </div>
        `;

        const av = document.getElementById('profileAv');
        if(av) setAvatar(av, e.photo || '', (e.name||'E')[0]);
      }

      if(mode==='modal' && profileOverlay){
        profileOverlay.classList.remove('closing');
        profileModal?.classList.remove('closing');
        document.body.classList.add('lockScroll');
        profileOverlay.scrollTop = 0;
        profileOverlay.classList.add('show');
        profileOverlay.setAttribute('aria-hidden','false');

      } else {
        // modo página (nova aba)
        document.body.classList.add('profileOnly');
        const pp = document.getElementById('profilePage');
        if(pp){
          pp.setAttribute('aria-hidden','false');
        }
        const base = location.href.split('#')[0];
        const back = document.getElementById('ppBackLink');
        if(back){
          back.href = base;
          back.onclick = (ev)=>{ ev.preventDefault(); location.href = base; };
        }
        try{ window.scrollTo(0,0); }catch(e){}
        try{ document.title = `${e.name} | Karameloo`; }catch(e){}
      }
    }

    function closeEditorProfile(){
      if(!profileOverlay) return;
      profileOverlay.classList.add('closing');
      profileModal?.classList.add('closing');
      setTimeout(()=>{
        profileOverlay.classList.remove('show','closing');
        profileModal?.classList.remove('closing');
        profileOverlay.setAttribute('aria-hidden','true');
        document.body.classList.remove('lockScroll');
      }, 220);
    }

    profileOverlay?.addEventListener('click', (e)=>{ if(e.target === profileOverlay) closeEditorProfile(); });

    // ===== Utils: copiar texto (Telefone etc.) =====
    function showToast(msg){
      const text = String(msg||'').trim();
      if(!text) return;
      let t = document.getElementById('miniToastKarameloo');
      if(!t){
        t = document.createElement('div');
        t.id = 'miniToastKarameloo';
        t.style.position='fixed';
        t.style.left='50%';
        t.style.bottom='26px';
        t.style.transform='translateX(-50%)';
        t.style.padding='10px 14px';
        t.style.borderRadius='999px';
        t.style.border='1px solid rgba(255,255,255,.14)';
        t.style.background='rgba(0,0,0,.55)';
        t.style.backdropFilter='none';
        t.style.color='rgba(255,255,255,.92)';
        t.style.fontWeight='900';
        t.style.fontSize='.92rem';
        t.style.zIndex='99999';
        t.style.opacity='0';
        t.style.transition='opacity .16s ease, transform .16s ease';
        document.body.appendChild(t);
      }
      t.confirmTimer && clearTimeout(t.confirmTimer);
      t.textContent = text;
      t.style.opacity='1';
      t.style.transform='translateX(-50%) translateY(0)';
      t.confirmTimer = setTimeout(()=>{
        t.style.opacity='0';
        t.style.transform='translateX(-50%) translateY(8px)';
      }, 1400);
    }

    async function copyText(text){
      const t = String(text||'').trim();
      if(!t) return;
      try{
        if(navigator.clipboard && window.isSecureContext){
          await navigator.clipboard.writeText(t);
        }else{
          const ta = document.createElement('textarea');
          ta.value = t;
          ta.style.position='fixed';
          ta.style.left='-9999px';
          ta.style.top='-9999px';
          document.body.appendChild(ta);
          ta.focus();
          ta.select();
          document.execCommand('copy');
          ta.remove();
        }
        showToast('Copiado ✅');
      }catch(e){
        alert('Não foi possível copiar. Texto: ' + t);
      }
    }

    // ===== Visualizar trabalho (lightbox) =====
    const workOverlay = document.getElementById('workOverlay');
    const workBody = document.getElementById('workBody');
    const workTitle = document.getElementById('workTitle');
    const workModal = document.getElementById('workModal');

    // ===== Abrir perfil em NOVA ABA (estilo Fiverr) =====
    function openEditorProfileTab(id){
      // Abre o perfil na MESMA aba (sem criar nova guia)
      const clean = location.href.split('#')[0];
      history.replaceState(null, '', clean + '#profile=' + encodeURIComponent(String(id)));
      try{ handleProfileRoute(); }catch(e){ console.error(e); }
    }

    function handleProfileRoute(){
      const h = String(location.hash || '');
      const m = h.match(/^#profile=(.+)$/i) || h.match(/^#perfil=(.+)$/i);
      if(m){
        const id = decodeURIComponent(m[1] || '');
        // mostra apenas o perfil (em uma aba dedicada)
        document.body.classList.add('profileOnly');
        try{ openEditorProfile(String(id), 'page'); }catch(e){ console.error(e); }
        return;
      }
      // volta para o site normal
      document.body.classList.remove('profileOnly');
    }

    window.addEventListener('hashchange', handleProfileRoute);
    document.addEventListener('DOMContentLoaded', handleProfileRoute);
    // ===== Abrir RESUMO DO PEDIDO em NOVA ABA (pacote + editor) =====
    function openOrderSummaryTab(order){
      // Agora abre na MESMA ABA (overlay) — não abre nova guia.
      try{
        showOrderSummaryInline(order);
      }catch(err){
        console.error('openOrderSummaryInline error:', err);
      }
    }

    function showOrderSummaryInline(order){
      const ov = document.getElementById('orderOverlay');
      const body = document.getElementById('orderPageBody');
      if(!ov || !body){
        console.warn('[order] overlay container missing');
        return;
      }
      ov.classList.add('show');
      ov.setAttribute('aria-hidden','false');
      // trava o scroll do fundo e garante que o overlay abre no topo
try{ ov.scrollTop = 0; }catch(e){}
      try{ renderOrderSummaryPage(order); }catch(e){ console.error(e); }
      try{ window.__lastOrder = order; }catch(e){}
    }

    function closeOrderSummaryInline(goHome){
      const ov = document.getElementById('orderOverlay');
      if(ov){
        ov.classList.remove('show');
        ov.setAttribute('aria-hidden','true');
      }
      try{ document.body.classList.remove('lockScroll'); }catch(e){}

      // após fechar, volta pro fluxo normal
      try{
        if(goHome){
          // volta para tela principal pós-login
          if(typeof goProcurar === 'function') goProcurar(true);
        }else{
          // volta pra tela anterior (normalmente "Escolha seu Editor")
          if(typeof goProcurar === 'function') goProcurar(true);
        }
      }catch(e){}
    }

function renderOrderSummaryPage(order){
      const root = document.getElementById('orderPageBody');
      if(!root) return;

      const o = order || {};
      const editorId = String(o?.editor?.id || o?.editorId || o?.editor_id || '');
      const editorName = String(o?.editor?.name || o?.editorName || 'Editor');
      const title = String(o?.title || o?.packageTitle || 'Pedido');
      const desc = String(o?.desc || o?.description || '').trim();
      const eta = String(o?.eta || '—');
      const totalText = String(o?.totalText || (typeof brl==='function' ? brl(Number(o?.total||0)) : (o?.total||'—')));
      const tier = String(o?.tier || o?.level || '').trim();
      const kind = String(o?.kind || '').trim();

      // tenta achar detalhes do editor
      let editor = null;
      try{
        const all = (typeof getAllEditors==='function') ? (getAllEditors()||[]) : (window.EDITORS_DB||[]);
        editor = all.find(x => String(x.id) === editorId) || (window.exploreEditorsById ? window.exploreEditorsById[editorId] : null) || null;
      }catch(e){ editor=null; }

      const photo = (editor && editor.photo) ? String(editor.photo) : '';
      const stars = (editor && (editor.stars!=null)) ? Number(editor.stars) : (typeof START_STARS!=='undefined' ? Number(START_STARS) : 5);
      const tags = (editor && Array.isArray(editor.tags)) ? editor.tags : (Array.isArray(o?.tags) ? o.tags : []);
      const xp = (editor && editor.xp) ? String(editor.xp) : (tier || '—');
      const whats = (editor && editor.whats) ? String(editor.whats) : (o?.editor?.whats ? String(o.editor.whats) : '');

      const safe = (s)=> (typeof escapeHtml==='function' ? escapeHtml(String(s||'')) : String(s||'').replace(/[&<>"]/g, c=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c])));
      const starHTML = (typeof renderStarsHTML==='function') ? renderStarsHTML(stars, (typeof MAX_STARS!=='undefined'?MAX_STARS:10)) : '⭐'.repeat(Math.max(1, Math.round(stars)));

      root.innerHTML = `
        <div class="opGrid">
          <div class="opCard">
            <div class="pad">
              <div class="opTitle">${safe(title)}</div>
              <div class="opSub">${desc ? safe(desc) : 'Resumo do seu pedido para você revisar tudo antes do próximo passo.'}</div>

              <div class="opRow">
                <div class="opStat"><div class="k">Total estimado</div><div class="v">${safe(totalText)}</div></div>
                <div class="opStat"><div class="k">Entrega estimada</div><div class="v">${safe(eta)}</div></div>
                <div class="opStat"><div class="k">Nível</div><div class="v">${safe(xp || '—')}</div></div>
                <div class="opStat"><div class="k">Tipo</div><div class="v">${safe(kind || '—')}</div></div>
              </div>

              ${Array.isArray(o?.extras) && o.extras.length ? `
                <div style="margin-top:14px" class="opDivider"></div>
                <div class="pad" style="padding:14px 0 0">
                  <div style="font-weight:900; margin-bottom:8px">Extras</div>
                  <div class="opList">${o.extras.slice(0,18).map(x=>`<span class="opTag">${safe(x)}</span>`).join('')}</div>
                </div>
              ` : ''}

              <div class="opHint">
                Próximo passo (beta): checkout (PIX) + upload de arquivos + chat.
                Esta tela é só um resumo para você validar o pacote e o editor escolhidos.
              </div>
            </div>
          </div>

          <div class="opCard">
            <div class="pad">
              <div style="font-weight:900; margin-bottom:10px">Editor escolhido</div>
              <div class="opEditorTop">
                <div class="opAvatar" id="opAvatar">${photo ? `<img src="${safe(photo)}" alt="Foto do editor">` : safe((editorName||'E')[0])}</div>
                <div>
                  <div class="opEditorName">${safe(editorName)}</div>
                  <div class="opMini">${safe(xp || '')}</div>
                  <div class="stars" style="margin-top:6px">${starHTML}</div>
                </div>
              </div>

              ${tags && tags.length ? `<div class="opList" style="margin-top:12px">${tags.slice(0,12).map(t=>`<span class="opTag">${safe(t)}</span>`).join('')}</div>` : ''}

              <div class="opBtnRow">
                <button class="btn" type="button" id="opViewProfile">Ver perfil</button>
                <button class="btn secondary" type="button" id="opTalk">Falar com o editor</button>
              </div>

              <div class="opHint">Dica: se quiser trocar de editor depois, você consegue voltar e escolher outro (beta).</div>
            </div>
          </div>
        </div>
      `;

      // ações
      const back = document.getElementById('opBackLink');
      if(back){
        back.onclick = (e)=>{ e.preventDefault(); history.back(); };
      }
      document.getElementById('opGoHome')?.addEventListener('click', ()=>{
        location.hash = '';
        document.body.classList.remove('orderOnly');
        if(typeof showScreen==='function'){
          try{
            if(window.currentSession?.user){
              if(window.mode==='editor') showScreen(document.getElementById('screenEditor') || document.getElementById('screenStart'), true);
              else showScreen(document.getElementById('screenProcurar') || document.getElementById('screenStart'), true);
            }else{
              showScreen(document.getElementById('screenStart'), true);
            }
          }catch(_){}
        }
      });

      document.getElementById('opViewProfile')?.addEventListener('click', ()=>{
        if(editorId && typeof openEditorProfileTab==='function') openEditorProfileTab(editorId);
      });

      document.getElementById('opTalk')?.addEventListener('click', ()=>{
        const d = String(whats||'').replace(/\D/g,'');
        if(!d){
          alert('Este editor ainda não informou Telefone.');
          return;
        }
        const br = (d.length===10 || d.length===11) ? ('55'+d) : d;
        const msg = encodeURIComponent('Olá! Vi o resumo do meu pedido no Karameloo. Podemos conversar?');
        try{ navigator.clipboard?.writeText(msg); }catch(e){}
      // Abre no discador do telefone (sem nova guia)
      window.location.href = `tel:${br}`;
      });
    }

    function handleOrderRoute(){
      const h = String(location.hash || '');
      const m = h.match(/^#order=(.+)$/i) || h.match(/^#pedido=(.+)$/i);
      if(m){
        const key = decodeURIComponent(m[1] || '');
        document.body.classList.add('orderOnly');
        try{
          const raw = sessionStorage.getItem(key);
          if(!raw){
            const root = document.getElementById('orderPageBody');
            if(root) root.innerHTML = `<div class="opCard"><div class="pad"><div class="opTitle">Resumo indisponível</div><div class="opSub">Esse pedido não foi encontrado (pode ter expirado no cache).</div></div></div>`;
            return;
          }
          const order = JSON.parse(raw);
          renderOrderSummaryPage(order);
        }catch(e){
          console.error(e);
        }
        return;
      }
      document.body.classList.remove('orderOnly');
    }

    window.addEventListener('hashchange', handleOrderRoute);
    document.addEventListener('DOMContentLoaded', handleOrderRoute);

function openWorkLightbox(url, type){
      const u = String(url||'').trim();
      if(!u || !workOverlay || !workBody) return;

      const t = (type==='video') ? 'Vídeo' : 'Foto';
      if(workTitle) workTitle.textContent = 'Trabalho • ' + t;

      // conteúdo
      if(type === 'video'){
        workBody.innerHTML = `
          <div class="card" style="padding:12px">
            <video src="${escapeHtml(u)}" controls playsinline style="width:100%; max-height:70vh; border-radius:14px; background:rgba(0,0,0,.35)"></video>
          </div>
        `;
      }else{
        workBody.innerHTML = `
          <div class="card" style="padding:12px">
            <img src="${escapeHtml(u)}" alt="Trabalho do editor" style="width:100%; max-height:70vh; object-fit:contain; border-radius:14px; background:rgba(0,0,0,.35)" />
          </div>
        `;
      }

      workOverlay.classList.remove('closing');
      workModal?.classList.remove('closing');
      workOverlay.classList.add('show');
      workOverlay.setAttribute('aria-hidden','false');
    }

    function closeWorkLightbox(){
      if(!workOverlay) return;
      workOverlay.classList.add('closing');
      workModal?.classList.add('closing');
      setTimeout(()=>{
        workOverlay.classList.remove('show','closing');
        workModal?.classList.remove('closing');
        workOverlay.setAttribute('aria-hidden','true');
        if(workBody) workBody.innerHTML = '';
      }, 220);
    }
    workOverlay?.addEventListener('click', (e)=>{ if(e.target === workOverlay) closeWorkLightbox(); });

    // ===== Chat (demo local) =====
    function clientChatId(){
      // ID do "dono" da conversa: funciona tanto para Cliente quanto para Editor
      const s = (typeof getSession === 'function') ? getSession() : {active:null};
      if(s && s.active === 'editor'){
        const base = (editorData?.email || s.editorEmail || editorData?.cpf || editorData?.full || editorData?.first || editorData?.name || 'editor');
        return String(base).trim().toLowerCase().replace(/[^a-z0-9]+/g,'_').slice(0,72) || 'editor';
      }
      const base = (clientData?.email || s?.clientEmail || clientData?.cpf || clientData?.full || 'client');
      return String(base).trim().toLowerCase().replace(/[^a-z0-9]+/g,'_').slice(0,72) || 'client';
    }
    function chatKeyFor(peerId){
      return `karamelo_chat_${clientChatId()}_${String(peerId||'peer').replace(/[^a-z0-9_\-]+/gi,'_').slice(0,72)}`;
    }

    function fmtTime(ts){
      try{
        const d = new Date(ts||Date.now());
        return d.toLocaleTimeString('pt-BR', { hour:'2-digit', minute:'2-digit' });
      }catch(e){ return ''; }
    }
    function safeKey(s){
      return String(s||'').trim().toLowerCase().replace(/[^a-z0-9_\-]+/g,'_').slice(0,72) || 'x';
    }
    function contactsKey(){
      return `karameloo_contacts_${safeKey(clientChatId())}`;
    }
    function getSavedContacts(){
      const arr = lsGet(contactsKey(), []);
      return Array.isArray(arr) ? arr : [];
    }
    function saveContacts(list){
      lsSet(contactsKey(), Array.isArray(list) ? list.slice(0, 80) : []);
    }
    function upsertContact(c){
      if(!c || !c.id) return;
      const list = getSavedContacts();
      const id = String(c.id);
      const ix = list.findIndex(x=> String(x?.id)===id);
      const now = Date.now();
      const next = {
        id,
        name: String(c.name||'').trim() || 'Contato',
        role: c.role || '',
        whats: c.whats || '',
        lastText: c.lastText || '',
        lastTs: c.lastTs || now
      };
      if(ix>=0){
        list[ix] = { ...list[ix], ...next };
      }else{
        list.unshift(next);
      }
      // ordena por última interação
      list.sort((a,b)=> (b.lastTs||0) - (a.lastTs||0));
      saveContacts(list);
    }
    function mergeContactsFromOrders(){
      const s = getSession();
      const isEd = s?.active === 'editor';
      const orders = lsGet(LS_ORDERS, []);
      const list = Array.isArray(orders) ? orders : [];
      if(isEd){
        const meName = String(editorData?.full || editorData?.first || editorData?.name || 'Editor').trim().toLowerCase();
        list.forEach(o=>{
          const edName = String(o?.editor?.name||'').trim().toLowerCase();
          if(meName && edName && meName === edName){
            const ce = String(o?.client?.email||'').trim();
            const cn = String(o?.client?.name||'Cliente').trim();
            if(ce) upsertContact({ id: ce, name: cn, role:'cliente', lastText:'Pedido enviado', lastTs: o?.createdAt||Date.now() });
          }
        });
      }else{
        // cliente: guarda editores que já escolheu
        list.forEach(o=>{
          const ed = o?.editor;
          if(ed && ed.id){
            upsertContact({ id: String(ed.id), name: String(ed.name||'Editor'), role:'editor', lastText:'Pedido enviado', lastTs: o?.createdAt||Date.now() });
          }
        });
      }
    }

    function renderContacts(filter){
      if(!chatContacts) return;
      mergeContactsFromOrders();
      const q = String(filter||'').trim().toLowerCase();
      const list = getSavedContacts();
      const use = q ? list.filter(c=> (c.name||'').toLowerCase().includes(q) || String(c.id||'').toLowerCase().includes(q)) : list;
      chatContacts.innerHTML = '';
      if(!use.length){
        const empty = document.createElement('div');
        empty.style.opacity = '.85';
        empty.style.padding = '14px';
        empty.textContent = 'Nenhum contato ainda. Converse com um editor/cliente e ele aparecerá aqui.';
        chatContacts.appendChild(empty);
        return;
      }
      use.forEach(c=>{
        const item = document.createElement('div');
        item.className = 'contactItem' + (String(c.id)===String(chatActivePeerId) ? ' active' : '');
        item.setAttribute('role','listitem');
        item.onclick = ()=> openChatByContact(c);
        const av = document.createElement('div');
        av.className = 'contactAvatar';
        av.textContent = (String(c.name||c.id||'?').trim()[0]||'?').toUpperCase();
        const meta = document.createElement('div');
        meta.className = 'contactMeta';
        const nm = document.createElement('div');
        nm.className = 'contactName';
        nm.textContent = c.name || 'Contato';
        const last = document.createElement('div');
        last.className = 'contactLast';
        last.textContent = c.lastText || '—';
        meta.appendChild(nm); meta.appendChild(last);
        const tm = document.createElement('div');
        tm.className = 'contactTime';
        tm.textContent = c.lastTs ? fmtTime(c.lastTs) : '';
        item.appendChild(av); item.appendChild(meta); item.appendChild(tm);
        chatContacts.appendChild(item);
      });
    }

    function renderChatInfo(c){
      try{
        if(!chatInfoName) return;
        if(!c){
          chatInfoName.textContent = '—';
          if(chatInfoSub) chatInfoSub.textContent = 'Selecione um contato para ver detalhes';
          if(chatInfoRole) chatInfoRole.textContent = '—';
          if(chatInfoTags) chatInfoTags.textContent = '—';
          if(chatInfoPhone) chatInfoPhone.textContent = '—';
          if(chatInfoDone) chatInfoDone.textContent = '—';
          if(chatInfoResp) chatInfoResp.textContent = '—';
          if(chatInfoRepeat) chatInfoRepeat.textContent = '—';
          if(chatInfoDoneBar) chatInfoDoneBar.style.width = '0%';
          if(chatInfoRespBar) chatInfoRespBar.style.width = '0%';
          if(chatInfoRepeatBar) chatInfoRepeatBar.style.width = '0%';
          return;
        }

        const name = String(c.name||c.id||'Contato');
        chatInfoName.textContent = name;

        const role = (c.role==='editor') ? 'Editor' : 'Cliente';
        if(chatInfoRole) chatInfoRole.textContent = role;

        // puxa dados do editor quando existir
        let e = null;
        try{
          if(c.role==='editor' && typeof exploreEditorsById !== 'undefined') e = exploreEditorsById?.[String(c.id)];
        }catch(err){ e = null; }

        const tags = (e && Array.isArray(e.tags)) ? e.tags.slice(0,4) : [];
        if(chatInfoTags){
          chatInfoTags.textContent = tags.length ? tags.join(' • ') : (c.role==='editor' ? 'Edição • Conteúdo • Social' : 'Cliente');
        }

        // telefone (campo pode estar em c.whats)
        if(chatInfoPhone){
          const raw = String(c.whats||c.phone||'').trim();
          const dig = raw.replace(/\D/g,'');
          let pretty = raw || '—';
          if(dig.length===11) pretty = `(${dig.slice(0,2)}) ${dig.slice(2,7)}-${dig.slice(7)}`;
          else if(dig.length===10) pretty = `(${dig.slice(0,2)}) ${dig.slice(2,6)}-${dig.slice(6)}`;
          else if(!raw) pretty = '—';
          chatInfoPhone.textContent = pretty;
        }

        // métricas (beta: estimativas determinísticas)
        const seed = String(c.id||name);
        let h = 0;
        for(let i=0;i<seed.length;i++){ h = (h*31 + seed.charCodeAt(i)) % 100000; }
        const done = e?.done != null ? Number(e.done) : ( (h % 120) + 1 );
        const resp = e?.response != null ? Number(e.response) : ( 70 + (h % 30) );
        const rep = e?.repeat != null ? Number(e.repeat) : ( (h % 55) );

        if(chatInfoDone) chatInfoDone.textContent = String(done);
        if(chatInfoResp) chatInfoResp.textContent = resp + '%';
        if(chatInfoRepeat) chatInfoRepeat.textContent = rep + '%';

        if(chatInfoDoneBar) chatInfoDoneBar.style.width = Math.min(100, Math.max(6, (done/120)*100)) + '%';
        if(chatInfoRespBar) chatInfoRespBar.style.width = Math.min(100, Math.max(10, resp)) + '%';
        if(chatInfoRepeatBar) chatInfoRepeatBar.style.width = Math.min(100, Math.max(6, rep)) + '%';

        if(chatInfoSub){
          const s = getSession?.() || null;
          const who = (s?.active === 'editor') ? 'Editor ⇄ Cliente' : 'Cliente ⇄ Editor';
          chatInfoSub.textContent = who + ' • conversas salvas no navegador';
        }
      }catch(e){}
    }

    function setChatAvatarByContact(c){
      try{
        if(!chatAvatar) return;
        const name = String(c?.name || 'Contato');
        // tenta achar foto do editor (se existir no catálogo)
        let url = '';
        try{
          if(c?.role === 'editor' && typeof exploreEditorsById !== 'undefined'){
            const e = exploreEditorsById?.[String(c.id)];
            url = String(e?.photoUrl || e?.photo || e?.avatar || e?.profilePic || e?.profile_photo || '').trim();
          }
        }catch(e){}
        // ou foto direta no contato
        if(!url){
          url = String(c?.photoUrl || c?.photo || c?.avatar || '').trim();
        }

        // iniciais
        const parts = name.replace(/\s+/g,' ').trim().split(' ').filter(Boolean);
        const ini = (parts[0]?.[0] || 'K').toUpperCase();

        if(chatAvatarInitial) chatAvatarInitial.textContent = ini;

        if(url && chatAvatarImg){
          chatAvatarImg.src = url;
          chatAvatarImg.style.display = 'block';
          if(chatAvatarInitial) chatAvatarInitial.style.display = 'none';
        }else{
          if(chatAvatarImg){ chatAvatarImg.removeAttribute('src'); chatAvatarImg.style.display = 'none'; }
          if(chatAvatarInitial) chatAvatarInitial.style.display = 'block';
        }
      }catch(e){}
    }

function openInbox(){
      try{ ensureChatOverlayOnBody(); }catch(e){}

      const __sx = window.scrollX || 0;
      const __sy = window.scrollY || 0;
      // abre inbox sem selecionar conversa
      chatActivePeerId = null;
      chatCtx = null;
      if(chatTitle) chatTitle.textContent = 'Selecione um contato';
      setChatAvatarByContact({name:'Contato'});
      if(chatPeerSub){
        const s = getSession();
        chatPeerSub.textContent = (s?.active === 'editor') ? 'Editor ⇄ Cliente' : 'Cliente ⇄ Editor';
      }
      if(chatMsgs) chatMsgs.innerHTML = '';
      if(chatIntro) chatIntro.textContent = '* Selecione um contato à esquerda para abrir a conversa.';
      renderChatInfo(null);
      renderContacts(chatContactsSearch?.value || '');

      // auto: abre a última conversa (ou a única) para não ficar na tela vazia
      try{
        const list = getSavedContacts();
        const last = lsGet(LS_CHAT_LAST, null);
        let target = null;
        if(last && (last.id != null)){
          target = list.find(x=> String(x.id)===String(last.id)) || null;
        }
        if(!target && list.length===1) target = list[0];

        // se não houver conversa para abrir, já mostra a lista de contatos
        if(!target && list.length>0){
          try{ chatModal?.classList.add('showContacts'); }catch(e){}
        }

        if(target){
          setTimeout(()=>{
            try{
              const fresh = getSavedContacts();
              const t = fresh.find(x=> String(x.id)===String(target.id)) || target;
              openChatByContact(t);
            }catch(e){}
          }, 0);
        }
      }catch(e){}
      if(chatOverlay){
        chatOverlay.classList.remove('closing');
        chatModal?.classList.remove('closing');
        chatOverlay.classList.add('show');
        // evita pulo de rolagem ao abrir o inbox
        try{ requestAnimationFrame(()=> window.scrollTo(__sx, __sy)); }catch(e){}
        try{ document.body.classList.add('chatOpen'); }catch(e){}
        try{ aiPanel?.classList.remove('show'); }catch(e){}
chatOverlay.setAttribute('aria-hidden','false');
      }
    }
    window.openInbox = openInbox;
    function toggleChatContacts(force){
      try{
        if(!chatModal) return;
        if(force === false){
          chatModal.classList.remove('showContacts');
          return;
        }
        chatModal.classList.toggle('showContacts');
        chatModal.classList.remove('showInfo');
      }catch(e){}
    }
    window.toggleChatContacts = toggleChatContacts;

    function toggleChatInfo(force){
      try{
        if(!chatModal) return;
        if(force === false){
          chatModal.classList.remove('showInfo');
          return;
        }
        chatModal.classList.toggle('showInfo');
        chatModal.classList.remove('showContacts');
      }catch(e){}
    }
    window.toggleChatInfo = toggleChatInfo;

    function openChatByContact(c){
      if(!c) return;
      chatActivePeerId = String(c.id);
      chatCtx = {
        peerId: String(c.id),
        peerName: String(c.name||'Contato'),
        peerWhats: String(c.whats||''),
        key: chatKeyFor(String(c.id))
      };
      try{ lsSet(LS_CHAT_LAST, { id:String(c.id), name:String(c.name||'Contato'), role:String(c.role||''), whats:String(c.whats||c.phone||'') }); }catch(e){}

      try{ chatModal?.classList.remove('showContacts','showInfo'); }catch(e){}
      if(chatTitle) chatTitle.textContent = `Falar com ${chatCtx.peerName}`;
      if(chatIntro) chatIntro.textContent = '* Mensagens salvas no navegador.';
      renderChatInfo(c);
      setChatAvatarByContact(c);
      renderContacts(chatContactsSearch?.value || '');
      renderChat();
      setTimeout(()=>{ try{ chatInput?.focus({preventScroll:true}); }catch(e){ try{ chatInput?.focus(); }catch(e2){} } }, 50);
    }
    function renderChat(){
      if(!chatMsgs || !chatCtx) return;
      const arr = lsGet(chatCtx.key, []);
      const msgs = Array.isArray(arr) ? arr : [];
      chatMsgs.innerHTML = '';

      const fmtHM = (ts)=>{
        try{
          return new Date(ts||Date.now()).toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'});
        }catch(e){ return ''; }
      };
      const dayLabel = (ts)=>{
        const d = new Date(ts||Date.now());
        const now = new Date();
        const d0 = new Date(d.getFullYear(), d.getMonth(), d.getDate());
        const n0 = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const diff = Math.round((n0 - d0) / 86400000);
        if(diff===0) return 'Hoje';
        if(diff===1) return 'Ontem';
        try{
          return d.toLocaleDateString('pt-BR',{weekday:'short', day:'2-digit', month:'short'});
        }catch(e){ return ''; }
      };

      let lastDayKey = '';
      msgs.forEach(m=>{
        const ts = m.ts || Date.now();
        const d = new Date(ts);
        const dayKey = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
        if(dayKey !== lastDayKey){
          lastDayKey = dayKey;
          const sep = document.createElement('div');
          sep.className = 'waDay';
          sep.textContent = dayLabel(ts);
          chatMsgs.appendChild(sep);
        }

        const div = document.createElement('div');
        div.className = 'aiMsg' + (m.from==='me' ? ' me' : '');

        const text = document.createElement('span');
        text.className = 'waText';
        text.textContent = m.text || '';
        div.appendChild(text);

        const meta = document.createElement('span');
        meta.className = 'waMeta';
        meta.textContent = fmtHM(ts);

        if(m.from==='me'){
          const ticks = document.createElement('span');
          ticks.className = 'waTicks';
          ticks.textContent = '✓✓';
          meta.appendChild(ticks);
        }
        div.appendChild(meta);

        chatMsgs.appendChild(div);
      });

      chatMsgs.scrollTop = chatMsgs.scrollHeight;
    }
    function openChatWithEditorOrSignup(editorId){
      requestChatWithEditor(editorId);
    }

    function openChatWithEditor(editorId){
      // Cliente falando com Editor
      if(!isClientLogged()){
        setPostLoginIntent({ type:'chat', editorId:String(editorId||'') });
        openCadastro('cliente');
        return;
      }
      const e = exploreEditorsById?.[editorId];
      if(!e) return;

      // salva/atualiza contato
      upsertContact({ id: String(e.id), name: String(e.name||'Editor'), role:'editor', whats: String(e.whats||''), lastText:'', lastTs: Date.now() });

      // abre inbox e seleciona conversa
      openInbox();
      openChatByContact({ id:String(e.id), name:String(e.name||'Editor'), role:'editor', whats:String(e.whats||'') });
      closeEditorProfile();
    }
    function openChatWithClient(clientEmail, clientName){
      // Editor falando com Cliente (via Pedidos/Contatos)
      if(!isEditorLogged()){
        // se não estiver logado como editor, tenta ir para o modo editor
        if(window.becomeEditorFromClient) { window.becomeEditorFromClient(); return; }
        return;
      }
      const ce = String(clientEmail||'').trim();
      if(!ce) return;
      const cn = String(clientName||'Cliente').trim() || 'Cliente';
      upsertContact({ id: ce, name: cn, role:'cliente', lastText:'', lastTs: Date.now() });
      openInbox();
      openChatByContact({ id: ce, name: cn, role:'cliente', whats:'' });
    }

    function closeChat(){
      if(!chatOverlay) return;
      chatOverlay.classList.add('closing');
      chatModal?.classList.add('closing');
      try{ if(location.hash === '#inbox') history.pushState('', document.title, window.location.pathname + window.location.search); }catch(e){}
      setTimeout(()=>{
        chatOverlay.classList.remove('show','closing');
        chatModal?.classList.remove('closing');
        chatOverlay.setAttribute('aria-hidden','true');
        try{ document.body.classList.remove('chatOpen'); }catch(e){}
      }, 80);
    }
    // chatOverlay click-to-close disabled for widget mode
    async function sendChat(){
      if(!chatCtx || !chatInput) return;
      const txt = String(chatInput.value||'').trim();
      if(!txt) return;
      const mod = await moderateText(txt);
      if(!mod.ok){ alert(mod.reason || 'Mensagem bloqueada.'); return; }
      const arr = lsGet(chatCtx.key, []);
      const msgs = Array.isArray(arr) ? arr : [];
      msgs.push({from:'me', text: txt, ts: Date.now()});
      lsSet(chatCtx.key, msgs);

      // atualiza contatos
      upsertContact({ id: chatCtx.peerId, name: chatCtx.peerName, role:'', whats: chatCtx.peerWhats, lastText: txt, lastTs: Date.now() });
      renderContacts(chatContactsSearch?.value || '');

      chatInput.value = '';
      renderChat();

      // resposta simulada somente quando cliente fala com editor (demo)
      try{
        const s = getSession();
        if(s && s.active !== 'editor'){
          setTimeout(()=>{
            const a2 = lsGet(chatCtx.key, []);
            const m2 = Array.isArray(a2) ? a2 : [];
            m2.push({from:'them', text:`Recebi sua mensagem! Me conte: prazo, estilo e plataforma 🙂`, ts: Date.now()});
            lsSet(chatCtx.key, m2);
            upsertContact({ id: chatCtx.peerId, name: chatCtx.peerName, role:'', whats: chatCtx.peerWhats, lastText: 'Recebi sua mensagem! 🙂', lastTs: Date.now() });
            renderContacts(chatContactsSearch?.value || '');
            renderChat();
          }, 650);
        }
      }catch(e){}
    }
    chatInput?.addEventListener('keydown', (e)=>{
      if(e.key === 'Enter'){ e.preventDefault(); sendChat(); }
    });

    chatContactsSearch?.addEventListener('input', ()=> renderContacts(chatContactsSearch.value));
    function openChatPhone(){
      if(!chatCtx) return;
      const d = String((chatCtx.peerPhone || chatCtx.peerWhats || '')).replace(/\D/g,'');
      if(!d){
        alert('Este editor ainda não informou telefone.');
        return;
      }

      // tenta copiar (desktop) e, se for mobile, abrir discador
      const isMobile = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
      if(navigator.clipboard && navigator.clipboard.writeText){
        navigator.clipboard.writeText(d).catch(()=>{});
      }
      if(isMobile){
        window.location.href = `tel:${d}`;
      } else {
        alert(`Telefone copiado: ${d}`);
      }
    }

    // chips
    document.querySelector('.chipsRow')?.addEventListener('click', (e)=>{
      const btn = e.target?.closest('.chipBtn');
      if(!btn) return;
      exploreFilter = btn.getAttribute('data-filter') || 'all';
      renderProcurarEditors();
    });

    // inputs
    exploreSearch?.addEventListener('input', ()=>{ renderProcurarEditors(); });
    exploreSort?.addEventListener('change', ()=>{ renderProcurarEditors(); });

    marketCats?.addEventListener('click', (ev)=>{
      const btn = ev.target?.closest?.('.catBtn');
      if(!btn) return;
      const f = btn.getAttribute('data-filter') || 'all';
      if(f==='pkgs'){
        // atalho para ver pacotes (pode sem conta)
        if(!clientData) clientData = buildClientDefaults();
        paintClientTop();
        selectedEditorFromProcurar = null;
        renderPackages();
        showScreen(screenClient);
        return;
      }
      exploreFilter = f;
      // ativa visual
      marketCats.querySelectorAll('.catBtn').forEach(b=>b.classList.toggle('active', b===btn));
      renderProcurarEditors();
    });

    // Editor explore (clientes)
    exploreESearch?.addEventListener('input', ()=>{ renderProcurarClients(); });
    exploreESort?.addEventListener('change', ()=>{ renderProcurarClients(); });
    marketCatsE?.addEventListener('click', (ev)=>{
      const btn = ev.target?.closest?.('.catBtn');
      if(!btn) return;
      const f = btn.getAttribute('data-filter') || 'all';
      if(f==='pkgs'){
        // atalho: ir para seleção de pacotes do editor
        if(!isEditorLogged()) return openCadastro('editor');
        showScreen(screenEditor);
        return;
      }
      exploreEFilter = f;
      marketCatsE.querySelectorAll('.catBtn').forEach(b=>b.classList.toggle('active', b===btn));
      renderProcurarClients();
    });

    // ===== Loja do editor: filtrar pacotes pelo editor selecionado =====
    function openEditorShop(editorId){
      const e = exploreEditorsById?.[editorId];
      if(!e) return;
      if(!e.available){
        alert('Esse editor está OFF no momento.');
        return;
      }
      selectedEditorFromProcurar = e;
      closeEditorProfile();
      paintClientTop();
      goProcurar();
    }

    // ===== CLIENTE (perfil) =====
    const clientAvatarBox = document.getElementById('clientAvatarBox');
    const clientAvatarTop = document.getElementById('clientAvatarTop');
    const clientProfileName = document.getElementById('clientProfileName');
    const clientStars = document.getElementById('clientStars');
    const clientStarsTop = document.getElementById('clientStarsTop');

    const clientPhoto = document.getElementById('clientPhoto');
    const clWhats = document.getElementById('clWhats');
    const clCity = document.getElementById('clCity');
    const clNiche = document.getElementById('clNiche');
    const clMainPlatform = document.getElementById('clMainPlatform');
    const clAbout = document.getElementById('clAbout');
    const clContentType = document.getElementById('clContentType');
    const clGoal = document.getElementById('clGoal');
    const clFrequency = document.getElementById('clFrequency');
    const clDeadline = document.getElementById('clDeadline');
    const clRefs = document.getElementById('clRefs');

    let clientData = lsGet(LS_CLIENT, null);

    function ensureClientData(nome, sobrenome){
      const full = `${nome} ${sobrenome}`.trim();
      clientData = clientData || {
        first:nome||'Cliente',
        last:sobrenome||'',
        full: full || 'Cliente',
        stars: START_STARS,
        photo:'',
        cover:{preset:'none', img:''},
        whats:'',
        city:'',
        niche:'',
        mainPlatform:'instagram',
        about:'',
        cpf:'',
        email:'',
        dob:''
      };
      clientData.first = nome || clientData.first;
      clientData.last = sobrenome || clientData.last;
      clientData.full = full || clientData.full;
      clientData.stars = START_STARS;
      lsSet(LS_CLIENT, clientData);
    }

    function paintClientProfile(){
      if(clientProfileName) clientProfileName.textContent = clientData?.full || 'Cliente';
      if(clientStars) clientStars.innerHTML = renderStarsHTML(clientData?.stars ?? START_STARS, MAX_STARS);
      setAvatar(clientAvatarBox, clientData?.photo, (clientData?.full||'C')[0]);
      applyCoverToEl(document.getElementById('clientCover'), clientData?.cover);
      if(clWhats) clWhats.value = clientData?.whats || '';
      if(clCity) clCity.value = clientData?.city || '';
      if(clNiche) clNiche.value = clientData?.niche || '';
      if(clMainPlatform) clMainPlatform.value = clientData?.mainPlatform || 'instagram';
      if(clContentType) clContentType.value = clientData?.contentType || 'reels';
      if(clGoal) clGoal.value = clientData?.goal || 'engajamento';
      if(clFrequency) clFrequency.value = clientData?.frequency || '1sem';
      if(clDeadline) clDeadline.value = clientData?.deadline || '48h';
      if(clRefs) clRefs.value = clientData?.refs || '';
      if(clAbout) clAbout.value = clientData?.about || '';
      if(typeof syncClientCoverControls==='function') syncClientCoverControls();
    }

    function paintClientTop(){
      if(clientName) clientName.textContent = clientData?.first || 'Cliente';
      if(clientStarsTop) clientStarsTop.innerHTML = renderStarsHTML(clientData?.stars ?? START_STARS, MAX_STARS);
      setAvatar(clientAvatarTop, clientData?.photo, (clientData?.full||'C')[0]);
    }

    clientPhoto?.addEventListener('change', async (e)=>{
      const file = e.target.files?.[0];
      if(!file || !clientData) return;
      try{
        const data = await checkAndReadImage(file);
        clientData.photo = data;
      }catch(err){
        alert(String(err.message||err));
        e.target.value='';
        return;
      }
      lsSet(LS_CLIENT, clientData);
      paintClientProfile();
      paintClientTop();
    });

    function removeClientPhoto(){
      if(!clientData) return;
      clientData.photo = '';
      lsSet(LS_CLIENT, clientData);
      paintClientProfile();
      paintClientTop();
    }

    function saveClientProfileAndGo(){
      if(!clientData) clientData = {first:'Cliente', last:'', full:'Cliente', stars:START_STARS};
      clientData.whats = (clWhats?.value||'').trim();
      clientData.city = (clCity?.value||'').trim();
      clientData.niche = (clNiche?.value||'').trim();
      clientData.mainPlatform = clMainPlatform?.value || 'instagram';
      clientData.contentType = clContentType?.value || 'reels';
      clientData.goal = clGoal?.value || 'engajamento';
      clientData.frequency = clFrequency?.value || '1sem';
      clientData.deadline = clDeadline?.value || '48h';
      clientData.refs = (clRefs?.value||'').trim();
      clientData.about = (clAbout?.value||'').trim();
      clientData.stars = START_STARS;
      lsSet(LS_CLIENT, clientData);
      paintClientTop();
      goProcurar(true);
    }

    // ===== CUSTOM (Cliente) =====
    const custFotos = document.getElementById('custFotos');
    const custVideos = document.getElementById('custVideos');
    const custPlataforma = document.getElementById('custPlataforma');
    const custTipoVideo = document.getElementById('custTipoVideo');
    const custTotal = document.getElementById('custTotal');
    const custEntrega = document.getElementById('custEntrega');

    const PRICES = {
      // ✅ Valores "abaixo do mercado" + jogo psicológico (sem números redondos)
      foto: 18.40,

      // Vídeos curtos (base)
      video15: 16.90,
      video45: 24.90,
      video60: 29.90,

      // ✅ Vídeos longos: custo por minuto cai MUITO conforme a duração aumenta (até 3h)
      // (taxas aplicadas APENAS aos minutos adicionais após 1min)
      longRates: [
        { upToMin: 5,   perMin: 7.70 },  // 1–5 min
        { upToMin: 20,  perMin: 5.60 },  // 6–20 min
        { upToMin: 60,  perMin: 4.10 },  // 21–60 min
        { upToMin: 120, perMin: 3.20 },  // 61–120 min
        { upToMin: 180, perMin: 2.70 },  // 121–180 min (3h)
      ],

      platformMult: {
        reels:1.00, tiktok:1.00, insta:1.03, shorts:1.03,
        ytlong:1.05, facebookreels:1.02, kwai:1.00, snap:1.02,
        pinterest:1.02, linkedin:1.03, x:1.02
      }
    };

    // ✅ Calcula preço unitário para 1 vídeo longo (acima de 60s) com desconto progressivo por minuto
    function longVideoUnitPrice(durSec){
      const dur = Math.max(60, Number(durSec)||60);
      const mins = Math.min(180, Math.max(1, dur/60)); // até 3h
      let price = PRICES.video60; // inclui o 1º minuto
      let remaining = mins - 1;

      // aplica faixas de desconto
      let lastCap = 1;
      for(const band of (PRICES.longRates||[])){
        const cap = Math.min(180, Math.max(1, Number(band.upToMin)||lastCap));
        const room = Math.max(0, cap - lastCap);
        const take = Math.min(remaining, room);
        if(take > 0){
          price += take * (Number(band.perMin)||0);
          remaining -= take;
        }
        lastCap = cap;
        if(remaining <= 0) break;
      }
      // se sobrou por qualquer motivo, cobra a última taxa
      if(remaining > 0){
        const last = (PRICES.longRates && PRICES.longRates.length) ? PRICES.longRates[PRICES.longRates.length-1] : {perMin:2.70};
        price += remaining * (Number(last.perMin)||2.70);
      }

      // jogo de mercado no unitário (centavos psicológicos)
      return marketRoundBRL(price, Math.round(mins*13));
    }

    const EXTRA_OPTIONS = [
      { id:'optCorCine',    kind:'video', price:11.60 },
      { id:'optLegenda',    kind:'video', price:11.60 },
      { id:'optTransicoes', kind:'video', price:9.40  },
      { id:'optMotion',     kind:'video', price:11.60 },
      { id:'optIntroOutro', kind:'video', price:11.60 },
      { id:'optEstabilizar',kind:'video', price:11.60 },
      { id:'optSpeedRamp',  kind:'video', price:9.40  },

      { id:'optSFX',        kind:'video', price:9.40  },
      { id:'optAudio',      kind:'video', price:11.60 },
      { id:'optMusicSync',  kind:'video', price:9.90  },
      { id:'optVoiceClean', kind:'video', price:11.90 },

      { id:'optRetoquePro', kind:'photo', price:9.40  },
      { id:'optPele',       kind:'photo', price:9.40  },
      { id:'optFundo',      kind:'photo', price:11.60 },
      { id:'optCoresFoto',  kind:'photo', price:9.40  },
      { id:'optHDR',        kind:'photo', price:9.40  },
      { id:'optObjeto',     kind:'photo', price:11.60 },
      { id:'optTexto',      kind:'photo', price:9.40  },

      { id:'optHook',       kind:'video', price:7.90  },
      { id:'optCutsPro',    kind:'video', price:11.40 },
      { id:'optColorMatch', kind:'video', price:12.90 },
      { id:'optVfxLite',    kind:'video', price:9.80  },
      { id:'optReframe',    kind:'video', price:8.90  },
      { id:'optCapStyle',   kind:'video', price:9.70  },

      { id:'optDodgeBurn',  kind:'photo', price:12.40 },
      { id:'optNoisePhoto', kind:'photo', price:8.90  },
      { id:'optBatchPreset',kind:'photo', price:9.40  },
      { id:'optBlurBG',     kind:'photo', price:11.60 },
      { id:'optLensFix',    kind:'photo', price:9.90  },

        { id:'optLogoDesign', label:'Design de logo (1 conceito)', price:34.90, kind:'order' },
  { id:'optBrandKit', label:'Kit de marca p/ redes (5 artes)', price:54.90, kind:'order' },
  { id:'optIdentidade', label:'Identidade visual básica', price:99.90, kind:'order' },
  { id:'optLogoAnim', label:'Logo animado (5–7s)', price:59.90, kind:'order' },
  { id:'optIntroAnim', label:'Intro animada (até 7s)', price:44.90, kind:'order' },
  { id:'optLowerThirds', label:'Lower thirds (pack 3)', price:19.90, kind:'order' },
  { id:'optTrilhaSimples', label:'Trilha simples (biblioteca/licença)', price:14.90, kind:'order' },
  { id:'optSoundDesign', label:'Sound design (SFX) básico', price:19.90, kind:'order' },
  { id:'optMixMaster', label:'Mixagem + master (áudio)', price:24.90, kind:'order' },
{ id:'optThumbnail',  kind:'order', price:19.90 },
      { id:'optUrgente',    kind:'order', price:29.90 },

  { id:'optArtePeca', label:'Arte / ilustração (1 peça)', price:29.90, kind:'order' },
  { id:'optArteIA', label:'Arte em IA (pack 10 variações)', price:19.90, kind:'order' },
  { id:'optPackArtes', label:'Pack de artes (3 peças)', price:44.90, kind:'order' },

];

    function calcEntrega(total, urgent){
      // tempo mínimo agora é 35min (pedido simples)
      let eta = '35min';
      if(total <= 120) eta = '35min';
      else if(total <= 250) eta = '55min';
      else if(total <= 400) eta = '1h25';
      else if(total <= 700) eta = '2h20';
      else if(total <= 1000) eta = '3h30';
      else eta = '6h00';

      if(urgent){
        const steps = ['35min','55min','1h10','1h25','1h45','2h20','3h30','6h00'];
        const i = steps.indexOf(eta);
        if(i > 0) eta = steps[i-1]; // um nível mais rápido, sem passar de 35min
      }
      return eta;
    }

    function calcCustom(){
      const maxN = 999;
      const fotos = Math.min(maxN, Math.max(0, parseInt(custFotos?.value||'0',10) || 0));
      const vids  = Math.min(maxN, Math.max(0, parseInt(custVideos?.value||'0',10) || 0));
      if(custFotos) custFotos.value = String(fotos);
      if(custVideos) custVideos.value = String(vids);
      if(fotos==0 && vids==0){
        custTotal.textContent = brl(0);
        custEntrega.textContent = '—';
        return;
      }
      const plat  = custPlataforma?.value||'reels';
      const tipo  = custTipoVideo?.value||'15';

      const dur = Math.max(15, (parseInt(tipo,10) || 15)); // segundos
      let unitVideo = PRICES.video15;
      if(dur<=15){
        unitVideo = PRICES.video15;
      }else if(dur<=45){
        unitVideo = PRICES.video45;
      }else if(dur<=60){
        unitVideo = PRICES.video60;
      }else{
        // acima de 60s: desconto progressivo por minuto (até 3h)
        unitVideo = longVideoUnitPrice(dur);
      }

      const mult = PRICES.platformMult[plat] ?? 1.0;

      let extraVideo=0, extraPhoto=0, extraOrder=0;
      EXTRA_OPTIONS.forEach(o=>{
        const el=document.getElementById(o.id);
        if(!el||!el.checked) return;
        if(o.kind==='video') extraVideo+=o.price;
        else if(o.kind==='photo') extraPhoto+=o.price;
        else extraOrder+=o.price;
      });

      const tMult = tierMultiplier();
      const rawTotal = (fotos*((PRICES.foto+extraPhoto)*tMult)) + (vids*(((unitVideo*mult)+extraVideo)*tMult)) + extraOrder;

      // jitter leve só pra não ficar "redondo", depois aplicamos jogo psicológico nos centavos
      const jitter = (fotos+vids)>0 ? (0.18 + ((fotos*5 + vids*9 + dur)%9)*0.07) : 0;
      const totalRaw = Math.max(0, rawTotal + jitter);

      // ✅ jogo de mercado no TOTAL (sem subir preço; só ajusta centavos)
      const total = marketRoundBRL(totalRaw, (fotos*31 + vids*17 + dur));

      if(custTotal) custTotal.textContent = brl(total);
      const urgent = document.getElementById('optUrgente')?.checked || false;
      if(custEntrega) custEntrega.textContent = calcEntrega(total, urgent);
    }

    [custFotos,custVideos,custPlataforma,custTipoVideo].forEach(el=>{
      if(!el) return;
      el.addEventListener('input', calcCustom);
      el.addEventListener('change', calcCustom);
    });
    Array.from(document.querySelectorAll('[data-custom-opt]')).forEach(el=>{
      el.addEventListener('change', calcCustom);
    });

    // ===== UI: Personalizado (5 principais + setinha) =====
    let showAllCustomOptions = false;
    function toggleCustomOptions(){
      showAllCustomOptions = !showAllCustomOptions;
      const more = document.getElementById('customOptsMore');
      const btn  = document.getElementById('toggleCustomOpts');
      if(more) more.classList.toggle('collapsed', !showAllCustomOptions);
      if(btn) btn.textContent = showAllCustomOptions ? 'Mostrar menos ↑' : 'Ver mais opções ↓';
    }

    // ===== Pedido -> Escolher Editor =====
    function choosePackage(id){
      // ✅ Permite ver os editores (bots) mesmo sem estar logado como Cliente (modo demo/teste).
      // Se não estiver logado, marcamos intenção de login para finalizar depois.
      const logged = isClientLogged();

      const p = packages.find(x => x.id === id);
      if(!p) return;

      currentOrder = {
        kind: 'package',
        packageId: p.id,
        title: `${p.id}. ${p.name}`,
        total: packagePrice(p),
        tier: PRICE_TIER,
        eta: p.eta,
        needsLogin: !logged
      };

      if(!logged){
        try{ setPostLoginIntent({ type:'package', packageId:id }); }catch(e){}
      }

      if(typeof selectedEditorFromProcurar !== "undefined" && selectedEditorFromProcurar){
        createOrderAndFinish();
      }else{
        startPickEditor();
      }
    }

    function confirmCustom(){
      const logged = isClientLogged();
      if(!logged){
        try{ setPostLoginIntent({ type:'package' }); }catch(e){}
      }
      currentOrder = {
        kind: 'custom',
        title: 'Pacote Personalizado',
        totalText: custTotal?.textContent || brl(0),
        total: (function(){ try{ return parseBrl(custTotal?.textContent||'0'); }catch(e){ return 0; } })(),
        eta: custEntrega?.textContent || '35min',
        fotos: parseInt(custFotos?.value||'0',10),
        videos: parseInt(custVideos?.value||'0',10),
        tier: PRICE_TIER,
        needsLogin: !logged
      };
      if(typeof selectedEditorFromProcurar !== "undefined" && selectedEditorFromProcurar){
        createOrderAndFinish();
      }else{
        startPickEditor();
      }
    }

    // ===== Finalização simples (demo) =====
    const LS_ORDERS = 'karamelo_orders_v1';
    const LS_CHAT_LAST = 'karamelo_chat_last_peer_v1';

    async function createOrderAndFinish(){
      const order = {
        id: 'ord_' + Date.now() + '_' + Math.random().toString(16).slice(2,8),
        status: 'awaiting_payment',
        payment: { method:'pix', status:'pending' },
        ...currentOrder,
        createdAt: Date.now(),
        client: { name: clientData?.full || 'Cliente', email: clientData?.email || '' },
        editor: selectedEditorFromProcurar ? { id:selectedEditorFromProcurar.id, name:selectedEditorFromProcurar.name } : null
      };

      // Se tiver backend conectado, tenta enviar o pedido
      try{
        if(typeof apiBase === 'function' && apiBase()){
          await apiFetch('/api/orders', { method:'POST', body: JSON.stringify({ order }) });
        }else if(typeof SUPABASE_ENABLED !== 'undefined' && SUPABASE_ENABLED){
          const created = await supaCreateOrderFlow(order);
          order._supa = { id: created?.id || null, created_at: created?.created_at || null };
        }else{
          const arr = lsGet(LS_ORDERS, []);
          const list = Array.isArray(arr) ? arr : [];
          list.unshift(order);
          lsSet(LS_ORDERS, list.slice(0, 50));
        }
      }catch(e){
        // fallback local
        const arr = lsGet(LS_ORDERS, []);
        const list = Array.isArray(arr) ? arr : [];
        list.unshift(order);
        lsSet(LS_ORDERS, list.slice(0, 50));
      }

      try{ window.__lastOrder = order; }catch(e){}
      // Abre pagamento PIX (front-end)
      openPaymentInline(order);
      // não interrompe com alert: abre o pagamento na mesma aba
      // e mantém o usuário no fluxo.
}

    function backToProcurarFromPackages(){
      selectedEditorFromProcurar = null;
      currentOrder = null;
      goBackTo(screenProcurar);
    }

    function backToClientProfileFromPackages(){
      try{ paintClientProfile && paintClientProfile(); }catch(e){}
      goBackTo(screenClientProfile);
    }

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

    function backToOrder(){ goBack(); }

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


    // ==== Supabase sync (Editor) ====
    async function supaSyncEditorFromDb(){
      if(!(typeof SUPABASE_ENABLED !== 'undefined' && SUPABASE_ENABLED && window.supaClient)) return;
      try{
        const { data: uData, error: uErr } = await supaClient.auth.getUser();
        if(uErr) throw uErr;
        const user = uData?.user;
        if(!user) return;

        // tenta ler o perfil do editor
        const { data: row, error: rErr } = await supaClient
          .from('editor_profiles')
          .select('*')
          .eq('user_id', user.id)
          .maybeSingle();
        if(rErr) throw rErr;

        if(row){
          // aplica nos campos (sem quebrar fallback local)
          try{ if(edAvailable) edAvailable.checked = !!row.available; }catch(e){}
          try{ if(edXp && row.xp) edXp.value = row.xp; }catch(e){}
          try{ if(edWhats && row.whatsapp != null) edWhats.value = row.whatsapp || ''; }catch(e){}
          try{ if(edBio && row.bio != null) edBio.value = row.bio || ''; }catch(e){}
          try{ if(edSoft && row.softwares != null) edSoft.value = row.softwares || ''; }catch(e){}
          try{ if(edPortfolio && row.portfolio_text != null) edPortfolio.value = row.portfolio_text || ''; }catch(e){}
          try{ if(edTags) edTags.value = Array.isArray(row.tags) ? row.tags.join(', ') : (row.tags||''); }catch(e){}

          // reflete no editorData e preview
          try{
            if(!editorData) editorData = {first:'Editor', last:'', full:'Editor', stars:START_STARS, packages:[]};
            editorData.xp = edXp?.value || 'iniciante';
            editorData.whats = (edWhats?.value||'').trim();
            editorData.bio = (edBio?.value||'').trim();
            editorData.soft = (edSoft?.value||'').trim();
            editorData.portfolio = (edPortfolio?.value||'').trim();
            editorData.tags = (edTags?.value||'').split(',').map(s=>s.trim()).filter(Boolean).slice(0,12);
            lsSet(LS_EDITOR, editorData);
            renderPublicPreview();
          }catch(e){}
        }
      }catch(e){
        console.warn('[Editor] supaSyncEditorFromDb falhou:', e);
      }
    }


    const edSearchPkg = document.getElementById('edSearchPkg');
    const edQuick = document.getElementById('edQuick');
    const edPkgCount = document.getElementById('edPkgCount');
    const edPkgHint = document.getElementById('edPkgHint');
    const edPublicPreview = document.getElementById('edPublicPreview');

    let editorData = lsGet(LS_EDITOR, null);

    // ===== Portfólio (Editor) - demo (não salva em sessionStorage por tamanho) =====
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
            editorData.isMinor = !!(typeof isMinorEditor !== 'undefined' && isMinorEditor);
            editorData.minorConsent = !!(typeof minorConsentOk !== 'undefined' ? minorConsentOk : false);
            editorData.minorRgName = ((typeof isMinorEditor !== 'undefined' && isMinorEditor) ? minorRgName : '');
            editorData.minorStatus = ((typeof isMinorEditor !== 'undefined' && isMinorEditor) ? 'pendente' : 'ok');
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

    async function saveEditorProfile(){
      if(!editorData) editorData = {first:'Editor', last:'', full:'Editor', stars:START_STARS, packages:[]};
      editorData.xp = edXp?.value || 'iniciante';
      editorData.whats = (edWhats?.value||'').trim();
      editorData.bio = (edBio?.value||'').trim();
      editorData.soft = (edSoft?.value||'').trim();
      editorData.portfolio = (edPortfolio?.value||'').trim();
      editorData.tags = (edTags?.value||'').split(',').map(s=>s.trim()).filter(Boolean).slice(0,12);
      editorData.stars = START_STARS;

      // Sempre mantém fallback demo/local
      lsSet(LS_EDITOR, editorData);
      renderPublicPreview();

      // Se Supabase estiver habilitado e o editor estiver logado, salva também no banco
      try{
        if(typeof SUPABASE_ENABLED !== 'undefined' && SUPABASE_ENABLED && window.supaClient){
          const { data: uData, error: uErr } = await supaClient.auth.getUser();
          if(uErr) throw uErr;
          const user = uData?.user;
          if(user){
            const userId = user.id;

            // garante profile base (role = editor) - sem CPF por enquanto (vamos fazer depois)
            try{
              await supaClient.from('profiles')
                .upsert({ user_id: userId, display_name: (editorData.full||'').trim() || (user.user_metadata?.full_name||'') || '' , role: 'editor' }, { onConflict: 'user_id' });
            }catch(e){}

            const payload = {
              user_id: userId,
              available: !!(edAvailable && edAvailable.checked),
              xp: editorData.xp,
              whatsapp: editorData.whats,
              bio: editorData.bio,
              softwares: editorData.soft,
              tags: editorData.tags,
              portfolio_text: editorData.portfolio
            };

            const { error: pErr } = await supaClient
              .from('editor_profiles')
              .upsert(payload, { onConflict: 'user_id' });
            if(pErr) throw pErr;

            alert('Perfil do editor salvo (Supabase).');
            return;
          }
        }
      }catch(e){
        console.warn('[Editor] Falha ao salvar no Supabase, mantendo demo/local:', e);
      }

      alert('Perfil do editor salvo (demo).');
    }

    function resetEditor(){
      sessionStorage.removeItem(LS_EDITOR);
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

    function demoThumb(label){
      const t = String(label||'').slice(0, 28);
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="900">
        <defs>
          <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stop-color="#0f172a"/>
            <stop offset="0.55" stop-color="#0b1226"/>
            <stop offset="1" stop-color="#111827"/>
          </linearGradient>
        </defs>
        <rect width="100%" height="100%" fill="url(#g)"/>
        <circle cx="180" cy="160" r="140" fill="rgba(245,180,0,.18)"/>
        <circle cx="760" cy="240" r="190" fill="rgba(56,189,248,.14)"/>
        <rect x="70" y="610" width="760" height="170" rx="28" fill="rgba(255,255,255,.06)" stroke="rgba(255,255,255,.12)"/>
        <text x="110" y="690" font-family="ui-sans-serif, system-ui" font-size="54" font-weight="800" fill="rgba(255,255,255,.92)">Trabalho</text>
        <text x="110" y="748" font-family="ui-sans-serif, system-ui" font-size="44" font-weight="900" fill="rgba(255,224,138,.92)">${t.replace(/&/g,'&amp;').replace(/</g,'&lt;')}</text>
      </svg>`;
      return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
    }

const DEMO_EDITORS = [];

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
          stars: editorData.stars ?? START_STARS,
          bio: editorData.bio || '',
          soft: editorData.soft || '',
          portfolio: editorData.portfolio || '',
          works: { photos: (workPhotos||[]).slice(0, MAX_WORK_PHOTOS), videos: (workVideos||[]).slice(0, MAX_WORK_VIDEOS) }
        });
      }
      DEMO_EDITORS.forEach(e=> list.push({...e}));
      return list;
    }

    function isCompatible(editor, order){
      if(!editor.available) return false;
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
        <button class="btn" type="button" onclick="selectEditor('${e.id}')">Selecionar este editor</button>
        <button class="btn secondary" type="button" onclick="openEditorProfileFromPick('${e.id}')">Ver perfil do editor</button>
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
      openEditorProfileTab(_id);
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
        e = (window.EDITORS_DB || exploreEditorsCache || []).find(x => x.id === id) || { id, name:'Editor', rating:5, tags:[] };
      }

      selectedEditorFromProcurar = e;
      currentOrder.editor = { id: e.id, name: e.name, rating: e.rating, tags: e.tags };

      // Cria o pedido (e salva no Supabase quando SUPABASE_ENABLED=true)
      Promise.resolve(createOrderAndFinish())
        .catch(err => {
          console.error(err);
          alert('Erro ao criar o pedido. Abra o console (F12) para ver detalhes.');
        });
    }

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
const cepRaw=(inCEP?.value||'').trim();
      const cepD=cepDigits(cepRaw);
      const uf=(inUF?.value||'').trim().toUpperCase();
      const endereco=(inEndereco?.value||'').trim();
      const numero=(inNumero?.value||'').trim();
      const bairro=(inBairro?.value||'').trim();
      const cidade=(inCidade?.value||'').trim();
      const complemento=(inComplemento?.value||'').trim();

      const email=(inEmail?.value||'').trim();
      const senha=(inSenha?.value||'').trim();
      const senha2=(inSenha2?.value||'').trim();

      if(!senha2){ alert('Confirme sua senha.'); return; }
      if(senha2 !== senha){ alert('As senhas não conferem. Confira e tente novamente.'); return; }

      //      // Se Supabase estiver ativo, cadastro real (aparece em Authentication → Users)
      if(SUPABASE_ENABLED){
        try{
          showLoading('Entrando…','Verificando sua conta');
          // validações básicas (mantém as mesmas do modo local)
          if(!nome||!sobrenome){ alert('Preencha Nome e Sobrenome.'); return; }
          if(!dob){ alert('Preencha a data de nascimento.'); return; }
          if(!email){ alert('Preencha o email.'); return; }
          if(!senha || senha.length < 6){ alert('Crie uma senha (mínimo 6 caracteres).'); return; }
          if(!isValidCPF(cpfD)){ alert('CPF inválido.'); return; }
          if(role === 'editor'){
            const age = calcAge(dob);
            if(!(age >= 16)){
              alert('Para ser Editor/Vendedor, você precisa ter 16+ (regra do projeto).');
              return;
            }
          }

          // Endereço: obrigatório para Editor (quando necessário) (para contrato/pagamento com responsável futuramente)
          const roleValueUI = (typeof role !== 'undefined' && role) ? role : ((authState&&authState.role)?authState.role:'cliente');
          const needsAddress = (roleValueUI !== 'cliente'); // editor/júnior
          if(needsAddress){
            if(cepD.length !== 8){ alert('Informe um CEP válido (8 dígitos).'); return; }
            if(!uf || uf.length !== 2){ alert('Informe a UF (ex: SP).'); return; }
            if(!endereco){ alert('Informe a rua/avenida.'); return; }
            if(!numero){ alert('Informe o número.'); return; }
            if(!bairro){ alert('Informe o bairro.'); return; }
            if(!cidade){ alert('Informe a cidade.'); return; }
          }

showLoading('Criando conta…','Validando e salvando');

          const eKey = normEmail(email);

          const r = await supaRegisterFlow({ nome, sobrenome, dob, cpfD, email: eKey, senha, roleUi: role, addr: { cep: cepD, uf, endereco, numero, bairro, cidade, complemento } });
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
if(!nome||!sobrenome){ alert('Preencha Nome e Sobrenome.'); return; }
      if(!dob){ alert('Preencha a data de nascimento.'); return; }
      if(!email){ alert('Preencha o email.'); return; }
      if(!senha || senha.length < 4){ alert('Crie uma senha (mínimo 4 caracteres).'); return; }
      if(!isValidCPF(cpfD)){ alert('CPF inválido.'); return; }

      if(role === 'editor'){
        const age = calcAge(dob);
        if(!(age >= 16)){
          alert('Para ser Editor precisa ter 16+.\nMenores de 16: não podem criar conta neste projeto.');
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

      // Telefone: só números + ()- e espaço
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

      // IA: auto-open desativado (abre só quando o usuário clicar no botão)
});
;
(function(){
  const LS_KEY = "karameloo_admin_data_v1";
  const LS_SETTINGS = "karameloo_admin_settings_v1";

  function moneyBRL(n){
    try{
      return (Number(n||0)).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
    }catch(e){return "R$ " + (n||0);}
  }

  function getData(){
    let d;
    try{ d = JSON.parse(sessionStorage.getItem(LS_KEY)||""); }catch(e){ d=null; }
    if(!d || typeof d!=="object"){
      d = { users:[], orders:[], reports:0, updatedAt: Date.now() };
    }
    return d;
  }
  function setData(d){ sessionStorage.setItem(LS_KEY, JSON.stringify(d)); }

  function getSettings(){
    let s;
    try{ s = JSON.parse(sessionStorage.getItem(LS_SETTINGS)||""); }catch(e){ s=null; }
    if(!s || typeof s!=="object") s = { commission: 25 };
    return s;
  }
  function setSettings(s){ sessionStorage.setItem(LS_SETTINGS, JSON.stringify(s)); }

  
// (Admin removido)
// ---------- Pixel pine renderer (detailed like reference) ----------
  const far = document.getElementById("forestFar");
  const mid = document.getElementById("forestMid");
  const near = document.getElementById("forestNear");
  if(!far || !mid || !near){
    console.warn("[bg] forest canvases missing, skipping renderer");
    return;
  }
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

(function(){
  function qs(sel, root=document){ return root.querySelector(sel); }
  const startEmail = qs('#startEmail');
  const startSenha = qs('#startSenha');
  const startLoginBtn = qs('#startLoginBtn');
  const startCreate = qs('#startCreate');
  const startForgot = qs('#startForgot');
  const rolePills = Array.from(document.querySelectorAll('.rolePill'));

  // Estado local do seletor Cliente/Editor na tela inicial
  let startRole = 'cliente';
  function setStartRole(r){
    startRole = (r === 'editor') ? 'editor' : 'cliente';
    rolePills.forEach(b => b.classList.toggle('active', b.dataset.role === startRole));
  }
  rolePills.forEach(b => {
    b.addEventListener('click', () => setStartRole(b.dataset.role));
  });
  setStartRole('cliente');

  // Util: reusar o fluxo de login já existente (btnLogin do modal)
  async function runExistingLogin(){
    const email = (startEmail?.value || '').trim();
    const senha = (startSenha?.value || '').trim();
    if(!email || !senha){
      alert('Preencha e-mail e senha.');
      return;
    }

    // seta a role global que o código já usa
    try{ role = startRole; }catch(e){}

    // copia para os campos do modal (mesmo oculto) e dispara o handler oficial
    if(typeof loginEmail !== 'undefined' && loginEmail) loginEmail.value = email;
    if(typeof loginSenha !== 'undefined' && loginSenha) loginSenha.value = senha;

    if(typeof btnLogin !== 'undefined' && btnLogin){
      btnLogin.click();
      return;
    }

    // fallback (se o handler original não existir por algum motivo)
    alert('Falha ao iniciar login (handler não encontrado).');
  }

  startLoginBtn?.addEventListener('click', runExistingLogin);

  // Enter para entrar
  [startEmail, startSenha].forEach(el=>{
    el?.addEventListener('keydown', (ev)=>{
      if(ev.key === 'Enter'){ ev.preventDefault(); runExistingLogin(); }
    });
  });

  // Criar conta abre o fluxo original
  startCreate?.addEventListener('click', ()=>{
    try{ openAuth('register', startRole); }
    catch(e){ alert('Abrir cadastro não disponível.'); }
  });

  // Esqueci senha (placeholder)
  startForgot?.addEventListener('click', ()=>{
    // Evita o alert nativo (especialmente chato no mobile). Usa aviso leve.
    try{
      const em = (startEmail?.value || '').trim();
      if(em){
        toast(`Recuperação de senha: em breve.\nNo beta, se precisar resetar, fale com o ADM. (e-mail: ${em})`);
      }else{
        toast('Recuperação de senha: em breve.\nNo beta, se precisar resetar, fale com o ADM.');
      }
    }catch(e){
      // fallback silencioso
      console.log('Recuperação de senha (placeholder).');
    }
  });

  // Links legais (placeholder, se não existir no site)
  window.openTerms = window.openTerms || function(){
    alert('Termos de Serviço (placeholder).');
  };
  window.openPrivacy = window.openPrivacy || function(){
    alert('Política de Privacidade (placeholder).');
  };
})();
;

window.overlay = window.overlay || null;
window.ctxS = window.ctxS || null;
window.ctx = window.ctx || null;
window.ctxSea = window.ctxSea || null;
window.ctxForest = window.ctxForest || null;
window.renderSea = window.renderSea || function(){};
window.animateSea = window.animateSea || function(){};
window.animate = window.animate || function(){};
;

function openPaymentInline(order){
  try{
    const ov = document.getElementById('payOverlay');
    const body = document.getElementById('payPageBody');
    if(!ov || !body){ return; }

    // aceita chamada sem args
    const o = order || (window.__lastOrder || null);

    // trava scroll do fundo (sem quebrar telas existentes)
    document.documentElement.classList.add('noScroll');
    document.body.classList.add('noScroll');

    // dados básicos (fallback seguro)
    const editorName = (o && o.editor && o.editor.name) ? o.editor.name : (window.selectedEditorFromProcurar?.name || 'Editor');
    const pedidoTitle = (o && o.title) ? o.title : (window.currentOrder?.title || 'Pedido');
    const total = (o && typeof o.total === 'number') ? o.total : (window.currentOrder?.total || 0);
    const eta = (o && o.eta) ? o.eta : (window.currentOrder?.eta || '—');
    const orderId = (o && o.id) ? o.id : ('ord_' + Date.now());

    // chave pix (por enquanto, placeholder)
    const pixKey = (typeof PIX_KEY !== 'undefined' && PIX_KEY) ? PIX_KEY : 'pix@karameloo.com.br';
    const merchantName = (typeof PIX_MERCHANT_NAME !== 'undefined' && PIX_MERCHANT_NAME) ? PIX_MERCHANT_NAME : 'Karameloo';
    const merchantCity = (typeof PIX_MERCHANT_CITY !== 'undefined' && PIX_MERCHANT_CITY) ? PIX_MERCHANT_CITY : 'SAO PAULO';

    const payload = buildPixPayload({
      key: pixKey,
      name: merchantName,
      city: merchantCity,
      amount: total,
      txid: String(orderId).slice(-25).replace(/[^A-Za-z0-9]/g,'').slice(0,25) || 'KARAMELOO'
    });

    const qrUrl = buildQrUrl(payload);

    body.innerHTML = `
      <div class="payPanel">
        <div class="payPanelHeader">
          <h4>Resumo do pedido</h4>
          <span class="payChip">PIX • rápido</span>
        </div>
        <div class="payPanelContent">
          <div class="payRow">
            <div class="payKpi">
              <div class="k">Editor</div>
              <div class="v">${escapeHtml(editorName)}</div>
            </div>
            <div class="payKpi" style="text-align:right;">
              <div class="k">Total</div>
              <div class="v">${brl(total)}</div>
            </div>
          </div>

          <div class="paySummary">
            <div class="payItem">
              <div class="label">Pedido</div>
              <div class="value">${escapeHtml(pedidoTitle)}</div>
            </div>
            <div class="payItem">
              <div class="label">Entrega estimada</div>
              <div class="value">${escapeHtml(eta)}</div>
            </div>
            <div class="payItem">
              <div class="label">ID</div>
              <div class="value">${escapeHtml(orderId)}</div>
            </div>
            <div class="payItem">
              <div class="label">Status</div>
              <div class="value">Aguardando pagamento</div>
            </div>
          </div>

          <div class="payStepper">
            <div class="step on"><b>1</b> Abra o app do banco</div>
            <div class="step on"><b>2</b> Pix → QR ou Copia e Cola</div>
            <div class="step"><b>3</b> Confirme e volte</div>
          </div>

          <div style="margin-top:10px; display:flex; gap:10px; flex-wrap:wrap;">
            <button class="payBtn primary" type="button" onclick="markPixAsPaidAndContinue('${escapeAttr(orderId)}')">Já paguei</button>
            <button class="payBtn" type="button" onclick="closePaymentInline()">Voltar</button>
          </div>

          <div class="pixHint" style="margin-top:10px;">
            * No beta, a confirmação é manual (sem backend). Depois vamos automatizar via Supabase.
          </div>
        </div>
      </div>

      <div class="payPanel">
        <div class="payPanelHeader">
          <h4>Escaneie o QR Code</h4>
          <span class="payChip">${brl(total)}</span>
        </div>
        <div class="payPanelContent">
          <div class="pixBox">
            <div class="pixQR">
              <img alt="QR Code PIX" src="${qrUrl}">
            </div>

            <textarea class="pixCode" id="pixCopyPaste" readonly>${payload}</textarea>

            <div class="pixBtns">
              <button class="payBtn" type="button" onclick="copyPixCode()">Copiar código</button>
              <button class="payBtn" type="button" onclick="copyPixKey()">Copiar chave</button>
            </div>

            <div class="pixHint">
              Se preferir: copie o código e cole no Pix “Copia e Cola” do seu banco.<br>
              Chave (beta): <b>${escapeHtml(pixKey)}</b>
            </div>
          </div>
        </div>
      </div>
    `;

    ov.classList.add('show');
    ov.setAttribute('aria-hidden','false');
    try{ window.__lastOrder = o; }catch(e){}
  }catch(e){
    console.error(e);
  }
}

function closePaymentInline(){
  try{
    const ov = document.getElementById('payOverlay');
    if(ov){ ov.classList.remove('show'); ov.setAttribute('aria-hidden','true'); }
  }catch(e){}
  document.documentElement.classList.remove('noScroll');
  document.body.classList.remove('noScroll');
}

function cancelPaymentAndClose(){
  try{
    const o = window.__lastOrder || null;
    if(o){
      o.status = 'cancelled';
      if(o.payment){ o.payment.status = 'cancelled'; }
      // salva no sessionStorage se existir lista
      try{
        const arr = lsGet(LS_ORDERS, []);
        const list = Array.isArray(arr) ? arr : [];
        const idx = list.findIndex(x => x && x.id === o.id);
        if(idx >= 0){ list[idx] = o; lsSet(LS_ORDERS, list); }
      }catch(e){}
    }
  }catch(e){}
  closePaymentInline();
  try{ toast && toast('Pedido cancelado.', 'warn'); }catch(e){}
}

function copyPixCode(){
  const el = document.getElementById('pixCopyPaste');
  if(!el) return;
  const val = el.value || el.textContent || '';
  copyText(val);
  try{ toast && toast('Código PIX copiado!', 'ok'); }catch(e){}
}
function copyPixKey(){
  const o = window.__lastOrder || null;
  const key = (typeof PIX_KEY !== 'undefined' && PIX_KEY) ? PIX_KEY : 'pix@karameloo.com.br';
  copyText(key);
  try{ toast && toast('Chave copiada!', 'ok'); }catch(e){}
}

function markPixAsPaidAndContinue(orderId){
  try{
    const o = window.__lastOrder || null;
    if(o){
      o.status = 'paid';
      if(o.payment){ o.payment.status = 'paid'; o.payment.paidAt = Date.now(); }
      // salva
      try{
        const arr = lsGet(LS_ORDERS, []);
        const list = Array.isArray(arr) ? arr : [];
        const idx = list.findIndex(x => x && x.id === o.id);
        if(idx >= 0){ list[idx] = o; } else { list.unshift(o); }
        lsSet(LS_ORDERS, list.slice(0, 50));
      }catch(e){}
    }
  }catch(e){}
  closePaymentInline();

  // Depois do pagamento: abre a conversa com o editor
  try{
    if(typeof openChatWithEditor === 'function'){
      openChatWithEditor((window.__lastOrder && window.__lastOrder.editor) ? window.__lastOrder.editor : null);
    }else if(typeof openChatWidget === 'function'){
      openChatWidget(true);
    }else{
      // fallback: abre inbox se existir
      try{ location.hash = '#inbox'; }catch(e){}
    }
  }catch(e){
    console.error(e);
  }
  try{ toast && toast('Pagamento confirmado (beta). Chat liberado!', 'ok'); }catch(e){}
}

function escapeHtml(s){
  return String(s ?? '').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}
function escapeAttr(s){
  return String(s ?? '').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function copyText(text){
  const t = String(text || '');
  if(navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(t).catch(()=>fallbackCopy(t));
  }else{
    fallbackCopy(t);
  }
}
function fallbackCopy(t){
  const ta = document.createElement('textarea');
  ta.value = t;
  ta.style.position='fixed';
  ta.style.left='-9999px';
  ta.style.top='-9999px';
  document.body.appendChild(ta);
  ta.focus(); ta.select();
  try{ document.execCommand('copy'); }catch(e){}
  ta.remove();
}

function tlv(id, value){
  const v = String(value ?? '');
  const len = v.length.toString().padStart(2,'0');
  return String(id).padStart(2,'0') + len + v;
}
function crc16(payload){
  // CRC-16/CCITT-FALSE
  let crc = 0xFFFF;
  for(let i=0;i<payload.length;i++){
    crc ^= payload.charCodeAt(i) << 8;
    for(let j=0;j<8;j++){
      if(crc & 0x8000) crc = ((crc << 1) ^ 0x1021) & 0xFFFF;
      else crc = (crc << 1) & 0xFFFF;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4,'0');
}
function buildPixPayload({key, name, city, amount, txid}){
  const merchantKey = tlv('00','BR.GOV.BCB.PIX') + tlv('01', key);
  const merchantInfo = tlv('26', merchantKey);

  const addData = tlv('05', txid || '***');
  const additional = tlv('62', addData);

  const amt = (typeof amount === 'number' && isFinite(amount) && amount > 0) ? amount.toFixed(2) : '';
  let p =
    tlv('00','01') +
    tlv('01','12') +
    merchantInfo +
    tlv('52','0000') +
    tlv('53','986') +
    (amt ? tlv('54', amt) : '') +
    tlv('58','BR') +
    tlv('59', (name || 'Karameloo').substring(0,25)) +
    tlv('60', (city || 'SAO PAULO').substring(0,15)) +
    additional;

  // CRC placeholder
  p += '6304';
  p += crc16(p);
  return p;
}
function buildQrUrl(payload){
  const data = encodeURIComponent(payload);
  // serviço simples de QR (imagem). Se um dia quiser tirar, basta trocar aqui.
  return `https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=${data}`;
}

(function(){
  const nav = document.getElementById('edgeNav');
  const handle = document.getElementById('edgeHandle');
  if(handle){
    handle.addEventListener('click', () => {
      nav.classList.toggle('open');
      // auto-close after navigation on mobile
    });
  }


  const isMobile = () => window.matchMedia && window.matchMedia('(max-width: 820px)').matches;
  const closeEdgeNav = () => { if(nav) nav.classList.remove('open'); };

  // Close menu when tapping outside (mobile)
  document.addEventListener('click', (e) => {
    if(!isMobile()) return;
    if(!nav || !nav.classList.contains('open')) return;
    const wrap = nav.querySelector('.edgeWrap');
    const handleEl = document.getElementById('edgeHandle');
    if((wrap && wrap.contains(e.target)) || (handleEl && handleEl.contains(e.target))) return;
    closeEdgeNav();
  }, { capture: true });

  function safe(fn){ try{ return fn(); }catch(e){ return null; } }

  window.edgeGo = function(which){
    const s = safe(()=> window.getSession && window.getSession());
    const mode = (s && s.active) ? s.active : 'guest';

    // Helper: navigate safely
    const go = (id)=> safe(()=> window.showScreen && window.showScreen(document.getElementById(id)));

    // If not logged in, always go to login/start
    if(mode === 'guest'){
      go('screenStart');
      if(isMobile()) closeEdgeNav(); return; }

    // Common
    if(which === 'contatos'){
      safe(()=> window.openInbox && window.openInbox());
      if(isMobile()) closeEdgeNav(); return; }
    if(which === 'sair'){
      safe(()=> window.logout && window.logout());
      if(isMobile()) closeEdgeNav(); return; }

    // Home / inicio
    if(which === 'start'){
      if(mode === 'editor') go('screenEditor');
      else go('screenProcurar'); // cliente
      if(isMobile()) closeEdgeNav(); return; }

    // Procurar / marketplace
    if(which === 'procurar'){
      if(mode === 'editor') go('screenProcurarEditor');
      else go('screenProcurar');
      if(isMobile()) closeEdgeNav(); return; }

    // Pacotes
    if(which === 'pacotes'){
      if(mode === 'editor'){
        go('screenEditor');
        // jump to packages section if exists
        safe(()=> document.getElementById('editorPackages')?.scrollIntoView({behavior:'smooth', block:'start'}));
      }else{
        go('screenPacotes');
      }
      if(isMobile()) closeEdgeNav(); return; }

    // Perfil
    if(which === 'perfil'){
      if(mode === 'editor'){
        go('screenEditor');
        safe(()=> document.getElementById('editorProfile')?.scrollIntoView({behavior:'smooth', block:'start'}));
      }else{
        go('screenClientProfile');
      }
      if(isMobile()) closeEdgeNav(); return; }

    // Switch mode
    if(which === 'editor'){
      // If already editor, go to editor dashboard; if client, go to editor dashboard demo
      go('screenEditor');
      if(isMobile()) closeEdgeNav(); return; }
  };

  // Meus pedidos (placeholder: vamos ligar no backend depois)
  window.edgeMyOrders = function(){
    try{
      if(window.showToast) window.showToast('Em breve: Meus pedidos');
      else alert('Em breve: Meus pedidos');
    }catch(e){}
  };

  function refreshEdge(){
    const badge = document.getElementById('edgeModeBadge');
    const btnSair = document.getElementById('edgeBtnSair');
    const btnEditor = document.getElementById('edgeBtnEditor');
    const btnPerfil = document.getElementById('edgeBtnPerfil');
    const btnPacotes = document.getElementById('edgeBtnPacotes');
    const btnProcurar = document.getElementById('edgeBtnProcurar');

    const s = safe(()=> window.getSession && window.getSession());
    const mode = (s && s.active) ? s.active : 'guest';

    if(badge){
      badge.textContent = mode === 'cliente' ? 'Cliente' : mode === 'editor' ? 'Editor' : 'Visitante';
    }
    // Show/hide based on session
    if(btnSair) btnSair.style.display = (mode === 'guest') ? 'none' : '';
    if(btnPerfil) btnPerfil.style.display = (mode === 'guest') ? 'none' : '';
    if(btnPacotes) btnPacotes.style.display = (mode === 'cliente') ? '' : '';
    if(btnProcurar) btnProcurar.style.display = (mode === 'cliente') ? '' : '';
    if(btnEditor) btnEditor.style.display = (mode === 'editor' || mode === 'cliente') ? '' : 'none';
  }

  // refresh now and when screens change (best effort)
  refreshEdge();
  // monkey-patch showScreen to refresh when navigation occurs
  if(window.showScreen && !window.__edgeWrapped){
    window.__edgeWrapped = true;
    const _showScreen = window.showScreen;
    window.showScreen = function(){
      const r = _showScreen.apply(this, arguments);
      refreshEdge();
      return r;
    };
  }
  window.addEventListener('storage', refreshEdge);
})();
;

(function(){
  const sortEl = document.getElementById('cornerSort');
  if(sortEl){
    sortEl.addEventListener('change', ()=> cornerApplySort(sortEl.value));
  }
  // restore tab
  const savedTab = sessionStorage.getItem('kar_corner_tab') || 'motion';
  cornerSetTab(savedTab, true);
  const savedSort = sessionStorage.getItem('kar_corner_sort');
  if(savedSort && sortEl) sortEl.value = savedSort;
})();

function cornerToggleMenu(force){
  const el = document.getElementById('cornerControls');
  if(!el) return;
  const next = (typeof force === 'boolean') ? force : !el.classList.contains('menuOpen');
  el.classList.toggle('menuOpen', next);
  try{ sessionStorage.setItem('kar_corner_menu_open', next ? '1' : '0'); }catch(e){}
}

// restaura estado do menu (se o usuário deixou aberto)
(function(){
  const el = document.getElementById('cornerControls');
  if(!el) return;
  // Só restaura no mode celular (tela pequena) (pra não mudar nada no modo PC)
  const isTouch = () => {
    try{ return window.matchMedia && window.matchMedia("(max-width: 820px)").matches; }
    catch(e){ return false; }
  };
  if(!isTouch()) return;
  let v = null;
  try{ v = sessionStorage.getItem('kar_corner_menu_open'); }catch(e){}
  if(v === '1') el.classList.add('menuOpen');
})();

// Celular: fecha o menu ao tocar fora (e ESC no desktop)
(function(){
  const el = document.getElementById('cornerControls');
  if(!el) return;
  const isTouch = () => {
    try{ return window.matchMedia && window.matchMedia("(max-width: 820px)").matches; }
    catch(e){ return false; }
  };
  const close = () => {
    el.classList.remove('menuOpen');
    try{ sessionStorage.setItem('kar_corner_menu_open','0'); }catch(e){}
  };
  document.addEventListener('click', (ev)=>{
    if(!isTouch()) return;
    if(!el.classList.contains('menuOpen')) return;
    if(el.contains(ev.target)) return;
    close();
  }, {capture:true});
  document.addEventListener('keydown', (ev)=>{
    if(ev.key === 'Escape' && el.classList.contains('menuOpen')) close();
  });
})();

function cornerSetTab(tab, silent){
  try{ sessionStorage.setItem('kar_corner_tab', tab); }catch(e){}
  document.querySelectorAll('.cornerTab').forEach(btn=>{
    const isActive = btn.getAttribute('data-tab') === tab;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
  });

  if(silent) return;

  // se existir alguma função interna de filtro/aba, chama; senão só mantém visual
  if(typeof window.applyExploreTab === 'function'){
    window.applyExploreTab(tab);
  }else if(typeof window.setExploreCategory === 'function'){
    window.setExploreCategory(tab);
  }else{
    // fallback: tenta filtrar por atributos comuns, sem quebrar nada
    try{
      window.__kar_tab = tab;
    }catch(e){}
  }
}

function cornerApplySort(v){
  try{ sessionStorage.setItem('kar_corner_sort', v); }catch(e){}
  if(typeof window.applyExploreSort === 'function'){
    window.applyExploreSort(v);
    return;
  }
  // fallback: se existir um select de sort no app, sincroniza
  const maybe = document.querySelector('[data-sort-select], #sortSelect, #exploreSort');
  if(maybe && maybe.tagName === 'SELECT'){
    maybe.value = v;
    maybe.dispatchEvent(new Event('change', {bubbles:true}));
  }
}

function cornerOpenFilters(){
  // se o app tiver um modal/overlay de filtros, chama; senão mostra um aviso leve
  if(typeof window.openFilters === 'function'){ window.openFilters(); return; }
  if(typeof window.openExploreFilters === 'function'){ window.openExploreFilters(); return; }
  // fallback: alterna um "modo filtro" simples (não quebra)
  alert('Filtros: em breve vamos ligar isso aqui com as opções do app 🙂');
}

function cornerGoProfile(){
  // tenta navegar pelo sistema existente
  if(typeof window.edgeGo === 'function'){
    window.edgeGo('perfil'); return;
  }
  const target = document.getElementById('screenProfile') || document.getElementById('screenPerfil');
  if(target){
    target.scrollIntoView({behavior:'smooth', block:'start'});
  }
}

function cornerSoftRefresh(){
  // atualiza sem perder tudo: primeiro tenta re-render do app
  if(typeof window.renderExplore === 'function'){ window.renderExplore(); return; }
  location.reload();
}
;
// Marca automaticamente opções que têm preço para alinhar a coluna de valores
try{
  document.querySelectorAll('label.chk .priceTag').forEach(pt=>{
    const lab = pt.closest('label.chk');
    if(lab) lab.classList.add('priced');
  });
}catch(e){}
;

(function(){
  const __KML = window.__KML || (window.__KML = {});
  __KML._memoryAttachments = __KML._memoryAttachments || {}; // {threadKey: [{id, url, type}]}

  function nowTime(){
    const d = new Date();
    return d.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
  }
  function safeId(prefix='ord'){
    return prefix + "_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2,7);
  }
  function initials(name='Editor'){
    const parts = String(name).trim().split(/\s+/).filter(Boolean);
    const a = (parts[0]||'E')[0]||'E';
    const b = (parts[1]||parts[0]||'D')[0]||'D';
    return (a+b).toUpperCase();
  }
  function toast(msg){
    try{ document.querySelectorAll('.osToast').forEach(el=>el.remove()); }catch(e){}
    const el = document.createElement('div');
    el.className = 'osToast';
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(()=>{ el.style.opacity='0'; el.style.transition='opacity .25s ease'; }, 1800);
    setTimeout(()=>{ try{ el.remove(); }catch(e){} }, 2200);
  }

  function threadKey(order){
    const ed = order?.editor?.name || order?.editorName || 'editor';
    const id = order?.id || order?.orderId || 'noid';
    return `kml_thread_${id}_${ed}`.replace(/[^a-z0-9_]/gi,'_');
  }
  function loadThread(key){
    try{
      const raw = sessionStorage.getItem(key);
      if(!raw) return [];
      const arr = JSON.parse(raw);
      return Array.isArray(arr)? arr : [];
    }catch(e){
      return [];
    }
  }
  function saveThread(key, arr){
    try{
      const compact = arr.slice(-200).map(m=>({
        from: m.from,
        text: (m.text||'').slice(0, 4000),
        ts: m.ts,
        time: m.time
      }));
      sessionStorage.setItem(key, JSON.stringify(compact));
    }catch(e){}
  }

  function renderThreadMessages(key, msgsEl){
    const msgs = loadThread(key);
    const mem = (__KML._memoryAttachments[key] || []);
    msgsEl.innerHTML = '';
    msgs.forEach((m, idx)=>{
      const row = document.createElement('div');
      row.className = 'osMsgRow ' + (m.from === 'me' ? 'me' : 'them');
      const b = document.createElement('div');
      b.className = 'osBubble';
      const t = document.createElement('div');
      t.className = 't';
      t.textContent = m.text || '';
      b.appendChild(t);

      // attachment (session only)
      const att = mem.find(a => a.idx === idx);
      if(att){
        const box = document.createElement('div');
        box.className = 'osAttach';
        if(att.type && att.type.startsWith('video')){
          const v = document.createElement('video');
          v.controls = true;
          v.src = att.url;
          box.appendChild(v);
        }else{
          const img = document.createElement('img');
          img.src = att.url;
          img.alt = 'arquivo';
          box.appendChild(img);
        }
        b.appendChild(box);
      }

      const meta = document.createElement('div');
      meta.className = 'osMetaTime';
      meta.textContent = m.time || '';
      b.appendChild(meta);

      row.appendChild(b);
      msgsEl.appendChild(row);
    });
    // scroll end
    msgsEl.scrollTop = msgsEl.scrollHeight + 9999;
  }

  function addMessageToThread(key, from, text, attachment){
    const msgs = loadThread(key);
    const msg = { from, text: text || '', ts: Date.now(), time: nowTime() };
    msgs.push(msg);

    // session-only attachment mapping by message index
    if(attachment && attachment.url){
      const mem = (__KML._memoryAttachments[key] || (__KML._memoryAttachments[key] = []));
      mem.push({ idx: msgs.length - 1, url: attachment.url, type: attachment.type || 'image' });
    }

    saveThread(key, msgs);
  }

  // Override: createOrderAndFinish (Selecionar editor -> Order screen)
  window.createOrderAndFinish = function(editor, overrides){
    const pkg = (window.selectedPackage || window.__selectedPackage || null);
    const title = (pkg?.title || pkg?.name || 'Pacote');
    const price = Number(pkg?.price || pkg?.value || pkg?.total || 0);
    const eta = (pkg?.eta || pkg?.delivery || pkg?.time || '35min');
    const order = {
      id: safeId('order'),
      createdAt: Date.now(),
      title,
      price,
      eta,
      editor: {
        name: editor?.name || editor?.title || 'Editor',
        avatar: editor?.avatar || editor?.photo || editor?.image || '',
        phone: editor?.phone || editor?.tel || editor?.whatsapp || ''
      }
    };
    Object.assign(order, overrides || {});
    window.__kmlCurrentOrder = order;

    // Keep "last order" so the UI can resume.
    try{ sessionStorage.setItem('kml_last_order', JSON.stringify(order)); }catch(e){}

    // Open order screen overlay
    try{
      if(typeof showOrderSummaryInline === 'function'){
        showOrderSummaryInline(order);
      }else if(typeof openOrderSummaryTab === 'function'){
        openOrderSummaryTab(order);
      }else{
        toast('Não consegui abrir a tela do pedido (função não encontrada).');
      }
    }catch(e){
      console.error(e);
      toast('Erro ao abrir tela do pedido. Veja o Console (F12).');
    }
  };

  // Override: renderOrderSummaryPage (turn it into full-screen order + chat)
  window.renderOrderSummaryPage = function(order){
    const root = document.getElementById('orderPageBody');
    if(!root) return;

    const edName = order?.editor?.name || 'Editor';
    const av = order?.editor?.avatar || '';
    const phone = order?.editor?.phone || '';

    const key = threadKey(order);

    root.innerHTML = `
      <div class="osMain">
        <div class="osPanel">
          <div class="osSummary">
            <div class="pill">⭐ <b>Pedido</b> <span style="opacity:.85">• revise e confirme quando estiver satisfeito</span></div>

            <div class="kv"><span>Pacote</span><b>${escapeHtml(order?.title || '—')}</b></div>
            <div class="kv"><span>Entrega estimada</span><b>${escapeHtml(order?.eta || '—')}</b></div>
            <div class="kv"><span>Total</span><b>R$ ${Number(order?.price||0).toFixed(2).replace('.', ',')}</b></div>

            <div class="osHint">* No beta, mensagens ficam salvas no navegador. Arquivos enviados (foto/vídeo) ficam nesta sessão.</div>

            <div class="osCheck">
              <input id="osOk" type="checkbox">
              <div>
                <b>Estou satisfeito com o trabalho</b><br>
                Ao confirmar, você vai para o <b>pagamento via PIX</b>. Depois disso, o pedido entra em processamento.
              </div>
            </div>

            <div class="ctaRow">
              <button id="osConfirm" class="osBtn osBtnPrimary" disabled>Confirmar pacote</button>
              <button id="osCopyPhone" class="osBtn" style="${phone ? '' : 'display:none'}">Copiar telefone</button>
            </div>

            <div class="osHint" style="opacity:.75">Dica: use o chat ao lado para alinhar prazo, estilo e enviar/receber arquivos.</div>
          </div>
        </div>

        <div class="osPanel osChat">
          <div class="osChatTop">
            <div class="osAvatar" id="osAvatar">
              ${av ? `<img src="${escapeAttr(av)}" alt="avatar">` : `${escapeHtml(initials(edName))}`}
            </div>
            <div class="osTitleWrap">
              <div class="osTitle" title="${escapeAttr(edName)}">Falar com ${escapeHtml(edName)}</div>
              <div class="osSub">Cliente ⇄ Editor • conversa do pedido</div>
            </div>
          </div>

          <div class="osMsgs" id="osMsgs"></div>

          <div class="osComposer">
            <button class="osIconBtn" id="osAttachBtn" title="Anexar foto/vídeo">📎</button>
            <input class="osInput" id="osText" placeholder="Mensagem">
            <button class="osSend" id="osSend" title="Enviar">➤</button>
            <input id="osFile" type="file" accept="image/*,video/*" style="display:none">
          </div>
        </div>
      </div>
    `;

    const msgsEl = document.getElementById('osMsgs');
    const textEl = document.getElementById('osText');
    const sendEl = document.getElementById('osSend');
    const fileEl = document.getElementById('osFile');
    const attachBtn = document.getElementById('osAttachBtn');

    // seed thread with a friendly first editor msg if empty
    const existing = loadThread(key);
    if(existing.length === 0){
      addMessageToThread(key, 'editor', 'Recebi seu pedido! Me conte: prazo, estilo e plataforma 🙂', null);
    }

    renderThreadMessages(key, msgsEl);

    function doSend(attachment){
      const v = (textEl.value || '').trim();
      if(!v && !attachment){ toast('Digite uma mensagem ou anexe um arquivo.'); return; }
      addMessageToThread(key, 'me', v, attachment || null);
      textEl.value = '';
      renderThreadMessages(key, msgsEl);
    }

    sendEl.onclick = ()=> doSend(null);
    textEl.addEventListener('keydown', (e)=>{
      if(e.key === 'Enter' && !e.shiftKey){
        e.preventDefault();
        doSend(null);
      }
    });

    attachBtn.onclick = ()=> fileEl.click();
    fileEl.onchange = ()=>{
      const f = fileEl.files && fileEl.files[0];
      if(!f) return;
      const url = URL.createObjectURL(f);
      doSend({url, type: f.type});
      fileEl.value = '';
    };

    // confirm flow
    const ok = document.getElementById('osOk');
    const confirmBtn = document.getElementById('osConfirm');
    ok.addEventListener('change', ()=>{ confirmBtn.disabled = !ok.checked; });

        confirmBtn.onclick = (ev)=>{
      ev?.preventDefault?.();
      ev?.stopPropagation?.();

      if(!ok.checked){ toast('Marque "Estou satisfeito" para confirmar.'); return; }

      try{
        // Fecha APENAS o resumo (não navega / não volta para o início)
        const overlay = document.getElementById('orderOverlayInline');
        if(overlay) overlay.remove();
      }catch(e){}

      // Abre a tela de pagamento (PIX) imediatamente
      try{
        if(typeof openPaymentInline === 'function'){
          openPaymentInline(order);
        }else{
          toast('Tela de pagamento não encontrada.');
        }
      }catch(e){
        console.error(e);
        toast('Erro ao abrir pagamento. Veja o Console (F12).');
      }
    };

    // phone copy
    const copyBtn = document.getElementById('osCopyPhone');
    if(copyBtn){
      copyBtn.onclick = ()=>{
        try{
          navigator.clipboard.writeText(String(phone)).then(()=>toast('Telefone copiado!'));
        }catch(e){
          toast('Não consegui copiar. Selecione e copie manualmente.');
        }
      };
    }
  };

  // Escape helpers (safe for template injection)
  function escapeHtml(s){
    return String(s ?? '')
      .replaceAll('&','&amp;')
      .replaceAll('<','&lt;')
      .replaceAll('>','&gt;')
      .replaceAll('"','&quot;')
      .replaceAll("'","&#039;");
  }
  function escapeAttr(s){ return escapeHtml(s).replaceAll('`','&#096;'); }

})();

/* ===========================
   Supabase - gatilhos futuros
   (orders + chat). Seguro: não quebra se tabelas não existirem.
=========================== */
(function(){
  if (typeof window === 'undefined') return;

  async function _supaUser(){
    try{
      if (!window.SUPABASE_ENABLED || !window.supaClient) return null;
      const { data } = await window.supaClient.auth.getUser();
      return data?.user || null;
    }catch(e){ return null; }
  }

  async function createOrder(order){
    if (!window.SUPABASE_ENABLED || !window.supaClient) throw new Error('SUPABASE_DISABLED');
    const user = await _supaUser();
    if (!user) throw new Error('NOT_AUTH');
    // Espera tabela: orders(client_id, editor_id, payload, status, created_at)
    const payload = {
      client_id: user.id,
      editor_id: order?.editor_id || null,
      status: order?.status || 'pending',
      payload: order?.payload || order || {}
    };
    const { data, error } = await window.supaClient.from('orders').insert(payload).select().single();
    if (error) throw error;
    return data;
  }

  async function listMyOrders(role){
    if (!window.SUPABASE_ENABLED || !window.supaClient) throw new Error('SUPABASE_DISABLED');
    const user = await _supaUser();
    if (!user) throw new Error('NOT_AUTH');
    let q = window.supaClient.from('orders').select('*').order('created_at', { ascending:false }).limit(50);
    if (role === 'editor') q = q.eq('editor_id', user.id);
    else q = q.eq('client_id', user.id);
    const { data, error } = await q;
    if (error) throw error;
    return data || [];
  }

  async function ensureConversation(otherUserId){
    if (!window.SUPABASE_ENABLED || !window.supaClient) throw new Error('SUPABASE_DISABLED');
    const user = await _supaUser();
    if (!user) throw new Error('NOT_AUTH');
    const a = user.id, b = otherUserId;
    // Espera tabela: conversations(id, user_a, user_b, created_at)
    const { data: existing, error: e1 } = await window.supaClient
      .from('conversations')
      .select('*')
      .or(`and(user_a.eq.${a},user_b.eq.${b}),and(user_a.eq.${b},user_b.eq.${a})`)
      .limit(1);
    if (e1) throw e1;
    if (existing && existing.length) return existing[0];

    const { data: created, error: e2 } = await window.supaClient
      .from('conversations')
      .insert({ user_a:a, user_b:b })
      .select()
      .single();
    if (e2) throw e2;
    return created;
  }

  async function sendMessage(conversationId, text){
    if (!window.SUPABASE_ENABLED || !window.supaClient) throw new Error('SUPABASE_DISABLED');
    const user = await _supaUser();
    if (!user) throw new Error('NOT_AUTH');
    // Espera tabela: messages(id, conversation_id, sender_id, text, created_at)
    const { data, error } = await window.supaClient
      .from('messages')
      .insert({ conversation_id: conversationId, sender_id: user.id, text: String(text || '').slice(0,2000) })
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  async function listMessages(conversationId){
    if (!window.SUPABASE_ENABLED || !window.supaClient) throw new Error('SUPABASE_DISABLED');
    const { data, error } = await window.supaClient
      .from('messages')
      .select('*')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending:true })
      .limit(200);
    if (error) throw error;
    return data || [];
  }

  // Exponho uma API simples para você plugar depois sem caçar funções no código
  window.KaramelooBackend = {
    createOrder, listMyOrders,
    ensureConversation, sendMessage, listMessages
  };
})();
