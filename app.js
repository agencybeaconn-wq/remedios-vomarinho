import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm";
import { SUPABASE_URL, SUPABASE_KEY, VAPID_PUBLIC, LOGIN_DOMAIN, APP_VERSION } from "./config.js";

const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, storageKey: "remedios-auth" },
});

const $app = document.getElementById("app");
const $sheet = document.getElementById("sheet");
const $toast = document.getElementById("toast");
const $status = document.getElementById("status");

const S = {
  session: null, me: null, family: null, members: [], meds: [], schedules: [], admins: [],
  tab: "hoje", page: null, loading: true, loadError: null,
  online: navigator.onLine, rt: "connecting",
  pendingKeys: new Map(), busy: new Set(), failed: new Map(),
  installEvt: null, hist: null, histTab: "adm", lastStateSig: "",
};

/* ================= utilidades ================= */
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) =>
  (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16)));
const num = (n) => Number(n).toLocaleString("pt-BR", { maximumFractionDigits: 2 });
const tz = () => S.family?.timezone || "America/Sao_Paulo";

function parts(d, zone = tz()) {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  return Object.fromEntries(f.formatToParts(d).map((p) => [p.type, p.value]));
}
function localDate(d = new Date()) { const p = parts(d); return `${p.year}-${p.month}-${p.day}`; }
function addDays(ds, n) { const [y, m, d] = ds.split("-").map(Number); const t = new Date(Date.UTC(y, m - 1, d + n)); return t.toISOString().slice(0, 10); }
function zoned(ds, hm) {
  const [y, m, d] = ds.split("-").map(Number); const [hh, mm] = hm.split(":").map(Number);
  const want = Date.UTC(y, m - 1, d, hh, mm); let g = want;
  for (let i = 0; i < 3; i++) { const p = parts(new Date(g)); g += want - Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute); }
  return new Date(g);
}
const hm = (d) => { const p = parts(new Date(d)); return `${p.hour}:${p.minute}`; };
function dayLabel(ds) {
  const today = localDate();
  if (ds === today) return "hoje";
  if (ds === addDays(today, -1)) return "ontem";
  return new Intl.DateTimeFormat("pt-BR", { timeZone: "UTC", weekday: "long", day: "numeric", month: "long" }).format(new Date(ds + "T12:00:00Z"));
}
function whenText(d) { const ds = localDate(new Date(d)); const l = dayLabel(ds); return (l === "hoje" ? "" : l + " ") + "às " + hm(d); }
function dur(ms) {
  const min = Math.max(0, Math.round(ms / 60000));
  if (min < 1) return "menos de 1 min";
  const h = Math.floor(min / 60), m = min % 60;
  return h ? `${h} h${m ? " " + m + " min" : ""}` : `${m} min`;
}
function qty(m, q) {
  if (m.unit === "mL") return `${num(q)} mL`;
  return `${num(q)} ${Number(q) === 1 ? "comprimido" : "comprimidos"}`;
}
const tabsOf = (m, q) => m.tablet_strength ? `${qty(m, q)} de ${m.tablet_strength}` : qty(m, q);
const equivPending = (m) => !!m.tablet_strength && !m.equivalence_confirmed_at;
const ready = (m) => m.active && !!m.verified_at && !equivPending(m);
const unitWord = (m, n = 2) => (m.unit === "mL" ? "mL" : n === 1 ? "comprimido" : "comprimidos");
const medTitle = (m) => `${esc(m.name)} <span class="strength">${esc(m.strength)}</span>`;
const myName = () => S.me?.display_name || S.me?.username || "";

const ERR = {
  ja_administrado: "Este horário já tinha sido registrado (talvez pela outra pessoa). Nada foi duplicado.",
  sistema_nao_ativado: "O sistema ainda não foi ativado. Termine a conferência em Configurações.",
  medicamento_nao_conferido: "Este remédio ainda não foi conferido. Confira em Configurações.",
  quantidade_invalida: "Quantidade inválida.",
  quantidade_acima_receita: "Quantidade acima da máxima escrita na receita. Nada foi salvo.",
  horario_invalido: "Horário inválido (no futuro ou muito antigo).",
  sem_acesso: "Seu acesso não está liberado.",
  motivo_obrigatorio: "Escreva o motivo da correção.",
  falta_confirmar_gastrostomia: "Falta confirmar as orientações de administração pela sonda.",
  registro_ja_anulado: "Este registro já tinha sido desfeito.",
  equivalencia_nao_validada: "A troca de comprimido deste remédio ainda não foi validada pelo médico ou farmacêutico.",
};
function isNetwork(err) {
  const m = String(err?.message || err || "");
  return !navigator.onLine || /fetch|network|Load failed|abort|timeout|Failed to/i.test(m);
}
function errText(err) {
  if (isNetwork(err)) return "Sem conexão com a internet. NÃO FOI SALVO. Tente de novo.";
  const m = String(err?.message || err);
  for (const k in ERR) if (m.includes(k)) return ERR[k];
  if (m.includes("falta_conferir")) return "Ainda falta conferir: " + m.split("falta_conferir:")[1];
  return "Não foi salvo: " + m;
}
async function rpc(fn, args) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 15000);
  try {
    const { data, error } = await sb.rpc(fn, args).abortSignal(ctl.signal);
    return { data, error };
  } catch (e) { return { data: null, error: e }; } finally { clearTimeout(t); }
}

/* ================= dados ================= */
async function loadAll() {
  const uid = S.session.user.id;
  const [me, fam, mem, meds, sch] = await Promise.all([
    sb.from("members").select("*").eq("user_id", uid).maybeSingle(),
    sb.from("families").select("*").maybeSingle(),
    sb.from("members").select("user_id,username,display_name"),
    sb.from("medications").select("*").order("position"),
    sb.from("schedules").select("*").eq("active", true).order("time_of_day"),
  ]);
  for (const r of [me, fam, mem, meds, sch]) if (r.error) throw r.error;
  S.me = me.data; S.family = fam.data; S.members = mem.data || []; S.meds = meds.data || []; S.schedules = sch.data || [];
  if (!S.family) return;
  const since = new Date(Date.now() - 3 * 864e5).toISOString();
  const adm = await sb.from("administrations").select("*")
    .or(`slot_date.gte.${addDays(localDate(), -1)},given_at.gte.${since}`)
    .order("given_at", { ascending: false }).limit(500);
  if (adm.error) throw adm.error;
  S.admins = adm.data || [];
}
let reloadTimer = null;
function reloadSoon(ms = 250) { clearTimeout(reloadTimer); reloadTimer = setTimeout(reload, ms); }
async function reload() {
  if (!S.session) return;
  try { await loadAll(); S.loadError = null; } catch (e) { S.loadError = e; }
  S.loading = false; render();
}
let channel = null;
function subscribe() {
  if (channel) sb.removeChannel(channel);
  channel = sb.channel("familia");
  for (const t of ["administrations", "medications", "schedules", "families", "members"]) {
    channel.on("postgres_changes", { event: "*", schema: "public", table: t }, () => reloadSoon());
  }
  channel.subscribe((st) => {
    S.rt = st === "SUBSCRIBED" ? "ok" : st === "CHANNEL_ERROR" || st === "TIMED_OUT" || st === "CLOSED" ? "bad" : "connecting";
    if (st === "SUBSCRIBED") reloadSoon(50);
    renderStatus();
  });
}

/* ================= horários do dia ================= */
function slotsFor(ds) {
  const out = [];
  for (const m of S.meds) {
    if (m.kind !== "continuo" || !ready(m)) continue;
    for (const s of S.schedules) {
      if (s.medication_id !== m.id || !s.active) continue;
      const t = s.time_of_day.slice(0, 5);
      out.push({
        key: `${s.id}|${ds}`, med: m, sch: s, date: ds, time: t, at: zoned(ds, t),
        adm: S.admins.find((a) => a.schedule_id === s.id && a.slot_date === ds && a.status === "valido"),
      });
    }
  }
  return out;
}
function todaySlots() {
  const today = localDate(), now = Date.now();
  const y = slotsFor(addDays(today, -1)).filter((s) => !s.adm && now - s.at < 4 * 3600e3 && s.at > new Date(S.family.activated_at));
  return [...y, ...slotsFor(today)].sort((a, b) => a.at - b.at || a.med.position - b.med.position);
}
function slotState(s, now = Date.now()) { return s.adm ? "done" : now >= s.at.getTime() ? "late" : "wait"; }

/* ================= renderização ================= */
function renderStatus() {
  let h = "";
  if (!S.online) h = `<div class="bar off">Sem internet. Nada novo será salvo até a conexão voltar.</div>`;
  else if (S.session && S.rt === "bad") h = `<div class="bar warn">Conexão instável. Toque em <button class="link" data-act="reload">atualizar</button>.</div>`;
  $status.innerHTML = h;
}

function render() {
  renderStatus();
  if (!S.session) return renderLogin();
  if (S.loading) { $app.innerHTML = `<div class="spinner">Carregando…</div>`; return; }
  if (S.loadError && !S.family) {
    $app.innerHTML = `<div class="wrap"><div class="card red" style="margin-top:30px"><h2>Não consegui carregar</h2>
      <p class="small" style="margin-top:8px">${esc(errText(S.loadError))}</p>
      <button class="btn primary" data-act="reload">Tentar de novo</button></div></div>`;
    return;
  }
  if (!S.me || !S.family) {
    $app.innerHTML = `<div class="wrap"><div class="card red" style="margin-top:30px"><h2>Acesso não liberado</h2>
      <p style="margin-top:8px">Este usuário não está ligado à família.</p><button class="btn ghost" data-act="logout">Sair</button></div></div>`;
    return;
  }
  let body;
  if (S.page) body = PAGES[S.page]();
  else body = { hoje: viewHoje, estoque: viewEstoque, config: viewConfig }[S.tab]();
  const lateCount = S.family.activated_at ? todaySlots().filter((s) => slotState(s) === "late").length : 0;
  const lowCount = S.meds.filter((m) => m.active && ["low", "empty"].includes(stockLevel(m))).length;
  const tab = (id, ico, lbl, dot) => `<button data-act="tab" data-tab="${id}" ${!S.page && S.tab === id ? 'aria-current="page"' : ""}>
      <span class="ico" aria-hidden="true">${ico}</span><span><span class="lbl">${lbl}</span>${dot ? `<span class="dot">${dot}</span>` : ""}</span></button>`;
  $app.innerHTML = `<div class="wrap">${body}</div>
    <nav class="tabs" aria-label="Navegação"><div class="in">
      ${tab("hoje", "☀︎", "Hoje", lateCount)}${tab("estoque", "▤", "Estoque", lowCount)}${tab("config", "⚙︎", "Configurações", 0)}
    </div></nav>`;
  S.lastStateSig = stateSig();
  updateBadge(lateCount);
  if (!S.me.display_name && !$sheet.classList.contains("open")) sheetName(true);
}

function renderLogin() {
  $app.innerHTML = `<div class="login">
    <h1>Remédios Vó Marinho</h1>
    <p class="muted">Entre com o usuário e a senha que você recebeu. Depois disso o celular lembra de você.</p>
    <form id="login" autocomplete="on">
      <label class="f">Usuário<input class="i" name="u" autocapitalize="none" autocorrect="off" spellcheck="false" autocomplete="username" required></label>
      <label class="f">Senha<input class="i" name="p" type="password" autocomplete="current-password" required></label>
      <p class="err" id="loginErr" role="alert"></p>
      <button class="btn primary" type="submit">Entrar</button>
    </form></div>`;
}

/* ---------- HOJE ---------- */
function viewHoje() {
  const longDate = new Intl.DateTimeFormat("pt-BR", { timeZone: tz(), weekday: "long", day: "numeric", month: "long" }).format(new Date()).replace(/^./, (c) => c.toUpperCase());
  let h = `<header class="top"><p class="eyebrow">${esc(longDate)}</p><h1>Remédios de hoje</h1></header>`;
  if (!S.family.activated_at) {
    return h + `<div class="card amber"><h2>Falta conferir a receita</h2>
      <p style="margin-top:8px">Antes de usar, confira cada remédio com a receita e a embalagem, e coloque os horários exatos combinados com a equipe de saúde.</p>
      <button class="btn primary" data-act="page" data-page="conferencia">Fazer a conferência</button></div>
      ${eventualEntry()}`;
  }
  const slots = todaySlots(), now = Date.now();
  const todays = slots.filter((s) => s.date === localDate());
  const done = todays.filter((s) => s.adm).length;
  const next = slots.find((s) => slotState(s, now) === "wait");
  const late = slots.filter((s) => slotState(s, now) === "late");
  h += `<div class="card">
    <p><b style="font-size:24px">${done} de ${todays.length}</b> administrados hoje</p>
    <div class="progress" aria-hidden="true"><i style="width:${todays.length ? (done / todays.length) * 100 : 0}%"></i></div>
    ${next ? `<p class="next">Próximo: <b>${esc(next.time)}</b> · ${esc(next.med.name)} · <span data-cd="${next.at.getTime()}">${cdText(next.at)}</span></p>`
      : todays.length && done === todays.length ? `<p class="next" style="color:var(--green)"><b>Tudo de hoje foi registrado.</b></p>` : ""}
  </div>`;
  h += reportCard();
  if (late.length) h += `<div class="card red"><b>${late.length} ${late.length === 1 ? "remédio pendente" : "remédios pendentes"}</b> com horário ultrapassado. Se já deu, toque em “Já administrei”.</div>`;
  const unverified = S.meds.filter((m) => m.active && m.kind === "continuo" && (!ready(m) || !S.schedules.some((s) => s.medication_id === m.id)));
  if (unverified.length) h += `<div class="card amber small">Fora da lista por falta de conferência, validação ou horário: ${unverified.map((m) => esc(m.name)).join(", ")}.
     <button class="link" data-act="page" data-page="conferencia">Conferir</button></div>`;

  let lastKey = "";
  for (const s of slots) {
    const gk = s.date + s.time;
    if (gk !== lastKey) {
      lastKey = gk;
      const group = slots.filter((x) => x.date + x.time === gk);
      const allDone = group.every((x) => x.adm), anyLate = group.some((x) => slotState(x, now) === "late");
      h += `<div class="timehead ${anyLate ? "late" : ""}"><span class="t">${s.date !== localDate() ? "Ontem " : ""}${esc(s.time)}</span>
        <span class="cd">${allDone ? "concluído" : anyLate ? "horário ultrapassado" : `<span data-cd="${s.at.getTime()}">${cdText(s.at)}</span>`}</span>
        ${next && next.date + next.time === gk ? '<span class="badge">Próximo</span>' : ""}</div>`;
    }
    h += slotCard(s, now);
  }
  if (!slots.length) h += `<div class="card muted">Nenhum horário configurado ainda.</div>`;
  return h + eventualEntry();
}
function cdText(at) { const d = at.getTime() - Date.now(); return d > 0 ? "em " + dur(d) : "há " + dur(-d); }
function eventualEntry() {
  return `<div class="timehead"><span class="t" style="font-size:22px">Se necessário</span></div>
    <button class="entry" data-act="page" data-page="eventuais">
      <span>Remédios só quando precisar<span class="sub">Dor ou febre · enjoo ou vômito · intestino preso</span></span><span class="arrow">›</span></button>`;
}
function slotCard(s, now) {
  const st = slotState(s, now), m = s.med;
  const busy = S.busy.has(s.key), failed = S.failed.get(s.key);
  let state = "", action = "";
  if (st === "done") {
    state = `<p class="state">✓ Administrado ${esc(whenText(s.adm.given_at))} por ${esc(s.adm.given_by_name)}${Number(s.adm.quantity) !== Number(m.dose_qty) ? ` · ${esc(qty(m, s.adm.quantity))}` : ""}</p>`;
    action = `<button class="link" data-act="fix" data-id="${s.adm.id}">Corrigir este registro</button>`;
  } else {
    if (st === "late") state = `<p class="state">Pendente: horário ultrapassado</p>`;
    if (failed) state += `<p class="err">${esc(failed)}</p>`;
    action = `<button class="btn give" data-act="give" data-key="${s.key}" ${busy ? "disabled" : ""}>${busy ? "Salvando…" : failed ? "Tentar salvar de novo" : "Já administrei"}</button>`;
  }
  return `<article class="card slot ${st}">
    <h3>${medTitle(m)}</h3>
    ${doseBlock(m)}
    ${m.admin_notes ? `<p class="sonda"><b>Pela sonda:</b> ${esc(m.admin_notes)}</p>` : ""}
    ${state}${action}</article>`;
}

function doseBlock(m) {
  if (m.tablet_strength) return `<p class="dose">Administrar: <b>${esc(tabsOf(m, m.dose_qty))}</b></p>
    <p class="dose">Dose total: <b>${esc(m.strength)}</b> · ${esc(m.frequency_text.toLowerCase())}</p>`;
  return `<p class="dose">Dar <b>${esc(qty(m, m.dose_qty))}</b> · ${esc(m.frequency_text.toLowerCase())}</p>`;
}

/* ---------- SE NECESSÁRIO ---------- */
function lastGiven(m) { return S.admins.filter((a) => a.medication_id === m.id && a.status === "valido").sort((a, b) => new Date(b.given_at) - new Date(a.given_at))[0]; }
function viewEventuais() {
  let h = pageHead("Se necessário");
  h += `<p class="muted small">Estes remédios não são do dia a dia. Registre só quando der, conforme a receita.</p>`;
  for (const m of S.meds.filter((x) => x.active && x.kind === "eventual")) {
    const last = lastGiven(m);
    const since = last ? Date.now() - new Date(last.given_at) : null;
    const within = m.interval_confirmed && m.min_interval_hours && last && since < m.min_interval_hours * 3600e3;
    const dose = m.dose_min && m.dose_max ? `${num(m.dose_min)} a ${num(m.dose_max)} mL` : qty(m, m.dose_qty);
    h += `<article class="card slot ${within ? "late" : ""}">
      <h3>${medTitle(m)}</h3>
      <p class="dose"><b>${esc(m.condition_text || "")}</b></p>
      <p class="dose">Quantidade da receita: <b>${esc(dose)}</b></p>
      <p class="small muted">${m.interval_confirmed && m.min_interval_hours ? `A receita indica intervalo de ${num(m.min_interval_hours)} em ${num(m.min_interval_hours)} horas.` : "Intervalo entre as doses: ainda a confirmar com a equipe."}</p>
      ${m.admin_notes ? `<p class="sonda"><b>Pela sonda:</b> ${esc(m.admin_notes)}</p>` : ""}
      <p class="state" style="color:inherit;font-weight:600">${last ? `Última vez: ${esc(whenText(last.given_at))} por ${esc(last.given_by_name)} (${esc(qty(m, last.quantity))}), há ${dur(since)}.` : "Nenhum registro nos últimos 3 dias."}</p>
      ${within ? `<p class="err">Faz menos de ${num(m.min_interval_hours)} horas desde a última vez.</p>` : ""}
      ${!ready(m) || !S.family.activated_at ? `<p class="err">Disponível depois da conferência.</p>` :
        `<button class="btn ${within ? "ghost" : "primary"}" data-act="giveEventual" data-id="${m.id}">Registrar que administrei</button>`}
      ${last ? `<button class="link" data-act="fix" data-id="${last.id}">Corrigir o último registro</button>` : ""}
    </article>`;
  }
  return h;
}

/* ---------- ESTOQUE ---------- */
function stockLevel(m) {
  if (m.stock == null) return "unknown";
  if (Number(m.stock) <= 0) return "empty";
  if (Number(m.stock) <= Number(m.reorder_threshold)) return "low";
  return "ok";
}
function perDay(m) {
  if (m.kind !== "continuo") return 0;
  return Number(m.dose_qty || 0) * S.schedules.filter((s) => s.medication_id === m.id && s.active).length;
}
function viewEstoque() {
  const meds = S.meds.filter((m) => m.active);
  const need = meds.filter((m) => ["low", "empty"].includes(stockLevel(m)));
  const unknown = meds.filter((m) => stockLevel(m) === "unknown");
  let h = `<header class="top"><p class="eyebrow">Quantidades em casa</p><h1>Estoque</h1></header>`;
  h += `<div class="card ${need.length ? "red" : ""}"><h2 style="font-size:22px">Precisa comprar</h2>
    ${need.length ? `<ul class="plain">${need.map((m) => `<li><b>${esc(m.name)} ${esc(m.strength)}</b>: ${stockLevel(m) === "empty" ? "ESGOTADO" : `restam ${esc(qty(m, m.stock))}`}</li>`).join("")}</ul>`
      : `<p class="muted" style="margin-top:6px">Nada por enquanto.</p>`}</div>`;
  if (unknown.length) h += `<div class="card amber small">Falta informar quantos tem em casa de: ${unknown.map((m) => esc(m.name)).join(", ")}. Toque em “Contar o que tem” em cada um.</div>`;
  for (const m of meds) {
    const lv = stockLevel(m), pd = perDay(m);
    h += `<article class="card ${lv === "empty" || lv === "low" ? "red" : ""}">
      <h3 style="font-size:22px">${medTitle(m)}</h3>
      ${m.tablet_strength ? `<p class="small muted">Comprimidos em casa: <b>${esc(m.tablet_strength)}</b> cada${equivPending(m) ? " (troca aguardando validação)" : ""}</p>` : ""}
      ${lv === "unknown" ? `<p class="stock-num" style="font-size:22px;color:var(--muted)">Quantidade não informada</p>` :
        `<p class="stock-num ${lv !== "ok" ? "red" : ""}">${esc(num(Math.max(0, m.stock)))} <span style="font-size:20px">${unitWord(m, m.stock)}${m.tablet_strength ? " de " + esc(m.tablet_strength) : ""}</span></p>`}
      ${lv === "empty" ? `<span class="pill red">Estoque esgotado</span>` : lv === "low" ? `<span class="pill red">Estoque baixo: comprar</span>` : lv === "ok" ? `<span class="pill green">Estoque normal</span>` : ""}
      ${lv !== "unknown" && pd && m.stock > 0 ? `<p class="small muted" style="margin-top:8px">Dá para cerca de ${Math.floor(m.stock / pd)} dias no ritmo atual.</p>` : ""}
      ${Number(m.stock) < 0 ? `<p class="small err">A contagem ficou abaixo de zero. Conte o que tem e corrija.</p>` : ""}
      ${m.kind === "continuo" && pd ? `<p class="small muted" style="margin-top:6px">Desconta ${esc(tabsOf(m, m.dose_qty))} a cada registro.</p>` : ""}
      <p class="small muted" style="margin-top:6px">Avisa para comprar com ${esc(num(m.reorder_threshold))} ${unitWord(m)} ou menos.</p>
      <button class="btn primary" data-act="stockAdd" data-id="${m.id}">Adicionar estoque</button>
      <button class="btn ghost small" data-act="stockSet" data-id="${m.id}">${lv === "unknown" ? "Contar o que tem" : "Corrigir a contagem"}</button>
    </article>`;
  }
  return h;
}

/* ---------- CONFIGURAÇÕES ---------- */
function viewConfig() {
  const ok = !!S.family.activated_at;
  const entry = (page, t, sub) => `<button class="entry" data-act="page" data-page="${page}"><span>${t}<span class="sub">${sub}</span></span><span class="arrow">›</span></button>`;
  return `<header class="top"><p class="eyebrow">Você entrou como ${esc(myName())}</p><h1>Configurações</h1></header>
    ${entry("conferencia", "Remédios e horários", ok ? "Sistema ativo · editar cadastro e horários" : "Conferência pendente")}
    ${entry("notificacoes", "Lembretes no celular", "Ativar, testar e limitações")}
    ${entry("familiares", "Familiares e acesso", "Nomes, senha e fuso horário")}
    ${entry("relatorio", "Relatório do mês", "Horários cumpridos, atrasos e onde melhorar")}
    ${entry("historico", "Histórico", "Tudo que foi registrado e corrigido")}
    ${entry("ajuda", "Como usar", "Passo a passo simples")}
    ${S.installEvt ? `<button class="btn ghost" data-act="install">Instalar na tela inicial</button>` : ""}
    <button class="btn ghost" data-act="logout">Sair deste celular</button>
    <p class="small muted center" style="margin-top:18px">Versão ${APP_VERSION}</p>`;
}
function pageHead(t) { return `<div class="pagehead"><button class="back" data-act="back" aria-label="Voltar">‹</button><h1>${esc(t)}</h1></div>`; }

function viewConferencia() {
  const f = S.family;
  let h = pageHead("Remédios e horários");
  h += `<div class="card amber small"><b>Importante.</b> Este app só organiza o que a equipe de saúde prescreveu. Ele não indica remédios, não muda doses e não diz o que fazer se uma dose for esquecida. Em dúvida, fale com a equipe.</div>`;
  if (f.activated_at) h += `<div class="card green"><b>Sistema ativo</b> desde ${esc(whenText(f.activated_at))}${f.activated_by_name ? " (" + esc(f.activated_by_name) + ")" : ""}.</div>`;
  else h += `<div class="card"><b>Passo 1.</b> Toque em cada remédio, confira com a receita e a embalagem, coloque os horários exatos e marque “Conferi”.</div>`;
  for (const kind of ["continuo", "eventual"]) {
    h += `<div class="timehead"><span class="t" style="font-size:21px">${kind === "continuo" ? "Uso contínuo" : "Se necessário"}</span></div>`;
    for (const m of S.meds.filter((x) => x.kind === kind)) {
      const times = S.schedules.filter((s) => s.medication_id === m.id).map((s) => s.time_of_day.slice(0, 5));
      const missingTimes = kind === "continuo" && !times.length;
      const chip = !m.active ? `<span class="pill gray">Suspenso</span>` : equivPending(m) ? `<span class="pill red">Falta validar a troca de comprimido</span>` : m.verified_at && !missingTimes ? `<span class="pill green">Conferido ✓</span>` : `<span class="pill red">${missingTimes ? "Falta horário" : "Falta conferir"}</span>`;
      h += `<button class="entry" data-act="editMed" data-id="${m.id}"><span>${esc(m.name)} ${esc(m.strength)}
        <span class="sub">${kind === "continuo" ? (times.length ? "Horários: " + times.join(" · ") : esc(m.frequency_text)) : esc(m.condition_text || "")}</span>
        <span style="display:block;margin-top:6px">${chip}</span></span><span class="arrow">›</span></button>`;
    }
  }
  h += `<div class="timehead"><span class="t" style="font-size:21px">Passo 2. Pela sonda</span></div>
    <div class="card ${f.gastro_ack_at ? "green" : ""}">
      <p>A receita diz <b>uso via gastrostomia</b>. Antes de usar, confirme com a equipe de saúde como dar <b>cada</b> remédio pela sonda: se pode triturar ou diluir, como diluir e como lavar a sonda. Não presuma que todo comprimido pode ser triturado.</p>
      <p class="small muted" style="margin-top:8px">Anote a orientação de cada um no campo “Como dar pela sonda” do remédio.</p>
      ${f.gastro_ack_at ? `<p class="state" style="color:var(--green);margin-top:10px">✓ Confirmado por ${esc(f.gastro_ack_by_name || "")} ${esc(whenText(f.gastro_ack_at))}</p>
        <button class="link" data-act="gastro" data-v="0">Desfazer esta confirmação</button>`
      : `<button class="btn primary" data-act="gastro" data-v="1">Já confirmei com a equipe de saúde</button>`}
    </div>`;
  const missing = S.meds.filter((m) => m.active && (!m.verified_at || equivPending(m) || (m.kind === "continuo" && !S.schedules.some((s) => s.medication_id === m.id))));
  h += `<div class="timehead"><span class="t" style="font-size:21px">Passo 3. Ativar</span></div><div class="card">`;
  if (f.activated_at) {
    h += `<p>O sistema está mostrando os horários na tela Hoje e enviando lembretes.</p>
      <button class="btn ghost" data-act="activate" data-v="0">Pausar e voltar para conferência</button>`;
  } else {
    h += missing.length || !f.gastro_ack_at
      ? `<p>Para ativar, falta: ${[...missing.map((m) => esc(m.name)), ...(f.gastro_ack_at ? [] : ["confirmação da sonda"])].join(", ")}.</p>`
      : `<p>Tudo conferido. Ao ativar, os horários aparecem na tela Hoje e os lembretes começam.</p>`;
    h += `<button class="btn give" data-act="activate" data-v="1" ${missing.length || !f.gastro_ack_at ? "disabled" : ""}>Ativar o sistema</button>`;
  }
  return h + `</div>`;
}

function viewNotificacoes() {
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone;
  const supported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  const perm = "Notification" in window ? Notification.permission : "unsupported";
  const times = [...new Set(S.schedules.filter((s) => S.meds.find((m) => m.id === s.medication_id && m.active && m.kind === "continuo")).map((s) => s.time_of_day.slice(0, 5)))].sort();
  let h = pageHead("Lembretes no celular");
  h += `<div class="card"><p>O app avisa <b>15 minutos antes</b> e <b>na hora</b> de cada horário que ainda não foi registrado. Os avisos vão para os celulares dos dois familiares.</p></div>`;
  if (ios && !standalone) {
    h += `<div class="card amber"><b>No iPhone, primeiro instale o app:</b><ol class="steps">
      <li>Abra este link no <b>Safari</b>.</li><li>Toque no botão <b>Compartilhar</b> (quadrado com seta).</li>
      <li>Toque em <b>Adicionar à Tela de Início</b>.</li><li>Abra o app pelo ícone novo e volte nesta tela.</li></ol></div>`;
  } else if (!supported) {
    h += `<div class="card red">Este navegador não aceita notificações. Use o Chrome (Android) ou instale o app na tela inicial (iPhone).</div>`;
  } else {
    h += `<div class="card" id="pushState"><p>Situação neste celular: <b id="pushLbl">${perm === "denied" ? "bloqueado" : "verificando…"}</b></p>
      ${perm === "denied" ? `<p class="small" style="margin-top:8px">As notificações foram bloqueadas. Abra os ajustes do navegador/celular, procure este site ou o app “Remédios” e permita notificações.</p>` : ""}
      <button class="btn primary" data-act="pushOn">Ativar lembretes neste celular</button>
      <button class="btn ghost small" data-act="pushTest">Enviar notificação de teste</button>
      <button class="link" data-act="pushOff">Desativar neste celular</button></div>`;
  }
  h += `<div class="card small"><b>Limitações que você precisa saber</b><ul class="plain">
    <li>O aviso depende de internet no celular. Sem conexão, ele pode chegar atrasado ou não chegar.</li>
    <li>No Android, economia de bateria e o modo “Não perturbe” podem atrasar ou silenciar o aviso. O som é o padrão de notificação do celular, não um alarme.</li>
    <li>No iPhone, só funciona com o app instalado na tela inicial (iOS 16.4 ou mais novo).</li>
    <li>Se a permissão for negada ou o app for removido, os avisos param.</li>
    <li>O app nunca marca um remédio como dado sozinho.</li></ul>
    <p style="margin-top:10px"><b>Por segurança, crie também alarmes no relógio do celular</b>${times.length ? ` nestes horários: <b>${times.join(" · ")}</b>` : " nos horários combinados"}.</p></div>`;
  setTimeout(refreshPushLabel, 0);
  return h;
}

function viewFamiliares() {
  let h = pageHead("Familiares e acesso");
  h += `<div class="card"><h2 style="font-size:21px">Quem usa</h2><ul class="plain">${S.members.map((m) =>
    `<li><b>${esc(m.display_name || "(sem nome)")}</b> <span class="muted small">usuário: ${esc(m.username)}${m.user_id === S.me.user_id ? " · você" : ""}</span></li>`).join("")}</ul>
    <button class="btn ghost small" data-act="name">Mudar meu nome</button>
    <button class="btn ghost small" data-act="password">Trocar minha senha</button></div>
    <div class="card"><h2 style="font-size:21px">Fuso horário</h2>
    <p class="small muted">Os horários seguem este fuso, mesmo se o celular estiver em outro.</p>
    <select class="i" id="tzSel">${[["America/Sao_Paulo", "Horário de Brasília (MG, SP, RJ…)"], ["America/Manaus", "Amazonas"], ["America/Cuiaba", "Mato Grosso"],
      ["America/Rio_Branco", "Acre"], ["America/Noronha", "Fernando de Noronha"]].map(([v, l]) => `<option value="${v}" ${S.family.timezone === v ? "selected" : ""}>${l}</option>`).join("")}</select>
    <button class="btn ghost small" data-act="saveTz">Salvar fuso</button></div>
    <div class="card small muted">Os dados ficam protegidos por login. Só os usuários desta família conseguem ver. Para incluir outra pessoa, peça a quem configurou o sistema.</div>`;
  return h;
}

function viewHistorico() {
  let h = pageHead("Histórico");
  h += `<div class="seg" role="group">${[["adm", "Remédios dados"], ["stk", "Estoque"], ["aud", "Alterações"]].map(([k, l]) =>
    `<button data-act="histTab" data-k="${k}" aria-pressed="${S.histTab === k}">${l}</button>`).join("")}</div>`;
  if (!S.hist) { setTimeout(loadHistory, 0); return h + `<div class="spinner">Carregando…</div>`; }
  if (S.hist.error) return h + `<div class="card red">${esc(errText(S.hist.error))}</div>`;
  const medName = (id) => { const m = S.meds.find((x) => x.id === id); return m ? `${m.name} ${m.strength}` : "?"; };
  const byDay = (rows, dateKey) => {
    const g = new Map();
    for (const r of rows) { const d = localDate(new Date(r[dateKey])); if (!g.has(d)) g.set(d, []); g.get(d).push(r); }
    return g;
  };
  let body = "";
  if (S.histTab === "adm") {
    for (const [d, rows] of byDay(S.hist.adm, "given_at")) {
      body += `<p class="hist-day">${esc(dayLabel(d))}</p>`;
      for (const a of rows) {
        const m = S.meds.find((x) => x.id === a.medication_id) || { unit: a.unit };
        body += `<div class="hist ${a.status === "anulado" ? "void" : ""}">
          <div class="what"><b>${esc(hm(a.given_at))}</b> · ${esc(medName(a.medication_id))} · ${esc(qty(m, a.quantity))}</div>
          <div class="meta">por ${esc(a.given_by_name)}${a.slot_time ? ` · horário das ${esc(a.slot_time.slice(0, 5))}` : " · se necessário"}${a.replaces_id ? " · correção de um registro anterior" : ""}</div>
          ${a.status === "anulado" ? `<div class="meta">Desfeito por ${esc(a.voided_by_name)} ${esc(whenText(a.voided_at))}: ${esc(a.void_reason)}</div>`
            : `<button class="link" data-act="fix" data-id="${a.id}">Corrigir</button>`}</div>`;
      }
    }
    if (!S.hist.adm.length) body = `<div class="card muted">Nenhum registro ainda.</div>`;
  } else if (S.histTab === "stk") {
    const lbl = { administracao: "Dado ao paciente", estorno: "Devolvido (registro desfeito)", compra: "Compra adicionada", ajuste: "Contagem corrigida" };
    for (const [d, rows] of byDay(S.hist.stk, "created_at")) {
      body += `<p class="hist-day">${esc(dayLabel(d))}</p>`;
      for (const r of rows) {
        const m = S.meds.find((x) => x.id === r.medication_id) || {};
        body += `<div class="hist"><div><b>${esc(hm(r.created_at))}</b> · ${esc(medName(r.medication_id))} · ${r.delta > 0 ? "+" : ""}${esc(num(r.delta))} ${unitWord(m)}</div>
          <div class="meta">${lbl[r.kind]} · ficou ${esc(num(r.stock_after))} · por ${esc(r.created_by_name)}${r.note ? " · " + esc(r.note) : ""}</div></div>`;
      }
    }
    if (!S.hist.stk.length) body = `<div class="card muted">Nenhuma movimentação ainda.</div>`;
  } else {
    for (const r of S.hist.aud) {
      body += `<div class="hist"><div><b>${esc(dayLabel(localDate(new Date(r.changed_at))))} ${esc(hm(r.changed_at))}</b> · ${esc(auditText(r))}</div>
        <div class="meta">por ${esc(r.changed_by_name)}</div></div>`;
    }
    if (!S.hist.aud.length) body = `<div class="card muted">Nenhuma alteração ainda.</div>`;
  }
  return h + body + `<button class="btn ghost" data-act="export">Baixar cópia de segurança (planilha)</button>
    <p class="small muted" style="margin-top:6px">Mostra os últimos 30 dias. A cópia de segurança traz tudo.</p>`;
}
function auditText(r) {
  const o = r.old_data || {}, n = r.new_data || {};
  if (r.table_name === "families") {
    if (o.activated_at !== n.activated_at) return n.activated_at ? "Sistema ativado" : "Sistema pausado para conferência";
    if (o.gastro_ack_at !== n.gastro_ack_at) return n.gastro_ack_at ? "Confirmou orientações da sonda" : "Desfez confirmação da sonda";
    if (o.timezone !== n.timezone) return "Fuso horário alterado para " + n.timezone;
    return "Dados da família alterados";
  }
  const med = S.meds.find((m) => m.id === (n.medication_id || n.id));
  const name = med ? med.name : "";
  if (r.table_name === "schedules") {
    if (r.action === "INSERT") return `${name}: horário ${String(n.time_of_day).slice(0, 5)} incluído`;
    if (o.active && !n.active) return `${name}: horário ${String(o.time_of_day).slice(0, 5)} removido`;
    return `${name}: horário ${String(o.time_of_day).slice(0, 5)} mudou para ${String(n.time_of_day).slice(0, 5)}`;
  }
  const fields = { name: "nome", strength: "dosagem", dose_qty: "quantidade", dose_min: "quantidade mínima", dose_max: "quantidade máxima", frequency_text: "frequência",
    condition_text: "condição", min_interval_hours: "intervalo", interval_confirmed: "confirmação do intervalo", admin_notes: "orientação da sonda",
    reorder_threshold: "limite de compra", tablet_strength: "dosagem do comprimido", equivalence_confirmed_at: "validação da troca de comprimido", verified_at: "conferência", active: "situação", times_per_day: "vezes por dia" };
  const ch = Object.keys(fields).filter((k) => JSON.stringify(o[k]) !== JSON.stringify(n[k])).map((k) => fields[k]);
  if (!ch.length) return "";
  if (ch.length === 1 && ch[0] === "conferência") return `${name}: ${n.verified_at ? "marcado como conferido" : "conferência desfeita"}`;
  return `${name}: alterou ${ch.join(", ")}`;
}
async function loadHistory() {
  const since = new Date(Date.now() - 30 * 864e5).toISOString();
  try {
    const [a, s, u] = await Promise.all([
      sb.from("administrations").select("*").gte("given_at", since).order("given_at", { ascending: false }).limit(1000),
      sb.from("stock_movements").select("*").gte("created_at", since).order("created_at", { ascending: false }).limit(1000),
      sb.from("audit_log").select("*").gte("changed_at", since).order("changed_at", { ascending: false }).limit(200),
    ]);
    for (const r of [a, s, u]) if (r.error) throw r.error;
    S.hist = { adm: a.data, stk: s.data, aud: u.data.filter((r) => auditText(r) !== "") };
  } catch (e) { S.hist = { error: e }; }
  if (S.page === "historico") render();
}

function viewAjuda() {
  return pageHead("Como usar") + `<div class="card"><h2 style="font-size:22px">No dia a dia</h2><ol class="steps">
    <li>Abra o app. A tela <b>Hoje</b> mostra os remédios na ordem dos horários.</li>
    <li>Confira o nome e a dosagem do remédio na embalagem.</li>
    <li>Depois de dar, toque no botão verde <b>Já administrei</b>. Pronto: o cartão fica verde.</li>
    <li>Tocou sem querer? Toque em <b>Desfazer</b> no aviso que aparece embaixo, ou em <b>Corrigir este registro</b>.</li></ol></div>
    <div class="card"><h2 style="font-size:22px">Cores</h2><ul class="plain">
    <li><b style="color:var(--green)">Verde</b>: já foi dado e registrado.</li>
    <li><b style="color:var(--red)">Vermelho</b>: horário passou sem registro, ou estoque baixo.</li>
    <li>Branco: ainda vai chegar a hora.</li></ul></div>
    <div class="card"><h2 style="font-size:22px">Remédios “se necessário”</h2>
    <p>Os remédios de uso eventual ficam em <b>Hoje → Se necessário</b>. Só registre quando realmente der. O app mostra quando foi a última vez.</p></div>
    <div class="card"><h2 style="font-size:22px">Estoque</h2>
    <p>Comprou uma caixa? Vá em <b>Estoque</b>, toque em <b>Adicionar estoque</b> e digite quantos comprimidos vieram. O app desconta sozinho a cada registro.</p></div>
    <div class="card amber"><b>O app não substitui a equipe de saúde.</b> Ele não indica remédio, não muda dose e não diz o que fazer se uma dose for esquecida. Em dúvida, ligue para a equipe.</div>`;
}


/* ---------- RELATÓRIO DO MÊS ---------- */
const TOL_MIN = 30;
const ymOf = (ds) => ds.slice(0, 7);
function monthBounds(ym) {
  const [y, m] = ym.split("-").map(Number);
  return { first: `${ym}-01`, last: new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10) };
}
function monthName(ym) {
  const [y, m] = ym.split("-").map(Number);
  return new Intl.DateTimeFormat("pt-BR", { timeZone: "UTC", month: "long", year: "numeric" }).format(new Date(Date.UTC(y, m - 1, 15))).replace(/^./, (c) => c.toUpperCase());
}
function monthOnly(ym) {
  const [y, m] = ym.split("-").map(Number);
  return new Intl.DateTimeFormat("pt-BR", { timeZone: "UTC", month: "long" }).format(new Date(Date.UTC(y, m - 1, 15)));
}
function shiftMonth(ym, n) { const [y, m] = ym.split("-").map(Number); return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7); }
const shortDate = (ds) => `${ds.slice(8, 10)}/${ds.slice(5, 7)}`;
const weekday = (ds) => new Intl.DateTimeFormat("pt-BR", { timeZone: "UTC", weekday: "short" }).format(new Date(ds + "T12:00:00Z")).replace(".", "");
// estado de uma linha num instante, a partir do histórico de alterações (em ordem)
function stateAt(rows, current, t) {
  let last = null;
  for (const r of rows) { if (new Date(r.changed_at) <= t) last = r; else break; }
  if (last) return last.new_data;
  if (rows.length) return rows[0].old_data;
  return current;
}
async function fetchAll(make) {
  let out = [], from = 0;
  for (;;) {
    const r = await make().range(from, from + 999);
    if (r.error) throw r.error;
    out = out.concat(r.data);
    if (r.data.length < 1000) return out;
    from += 1000;
  }
}
async function loadReport(ym) {
  S.rep = { ym, loading: true };
  try {
    const { first, last } = monthBounds(ym);
    const start = zoned(first, "00:00").toISOString(), end = zoned(addDays(last, 1), "00:00").toISOString();
    const [adm, sch, aud] = await Promise.all([
      fetchAll(() => sb.from("administrations").select("*")
        .or(`and(slot_date.gte.${first},slot_date.lte.${last}),and(schedule_id.is.null,given_at.gte.${start},given_at.lt.${end})`).order("given_at")),
      fetchAll(() => sb.from("schedules").select("*").order("created_at")),
      fetchAll(() => sb.from("audit_log").select("table_name,row_id,action,old_data,new_data,changed_at")
        .in("table_name", ["schedules", "medications", "families"]).order("changed_at")),
    ]);
    S.rep = { ym, data: computeReport(ym, adm, sch, aud) };
  } catch (e) { S.rep = { ym, error: e }; }
  if (S.page === "relatorio") render();
}
function computeReport(ym, adm, schAll, aud) {
  const { first, last } = monthBounds(ym);
  const now = Date.now(), today = localDate();
  const group = (tbl) => { const m = new Map(); for (const r of aud) if (r.table_name === tbl) { if (!m.has(r.row_id)) m.set(r.row_id, []); m.get(r.row_id).push(r); } return m; };
  const aS = group("schedules"), aM = group("medications"), aF = group("families");
  const famRows = aF.get(S.family.id) || [];
  const valid = adm.filter((a) => a.status === "valido");
  const bySlot = new Map(valid.filter((a) => a.schedule_id).map((a) => [a.schedule_id + "|" + a.slot_date, a]));
  const medName = (id) => { const m = S.meds.find((x) => x.id === id); return m ? `${m.name} ${m.strength}` : "Remédio"; };
  const slots = [], seen = new Set();
  const push = (date, time, medId, a) => {
    const at = zoned(date, time);
    let status = "sem", diff = null;
    if (a) {
      diff = Math.round((new Date(a.given_at) - at) / 60000);
      status = diff > TOL_MIN ? "atraso" : diff < -TOL_MIN ? "adiantado" : "ok";
    }
    slots.push({ date, time, at, medId, med: medName(medId), adm: a, status, diff });
  };
  for (let d = first; d <= last && d <= today; d = addDays(d, 1)) {
    const dEnd = zoned(addDays(d, 1), "00:00");
    for (const s of schAll) {
      const key = s.id + "|" + d;
      const a = bySlot.get(key);
      if (a) { seen.add(key); push(d, a.slot_time.slice(0, 5), s.medication_id, a); continue; }
      const st = stateAt(aS.get(s.id) || [], s, dEnd);
      if (!st || !st.active) continue;
      const time = String(st.time_of_day).slice(0, 5);
      const at = zoned(d, time);
      if (now - at.getTime() < TOL_MIN * 60e3) continue; // ainda dentro do prazo
      const fam = stateAt(famRows, S.family, at);
      if (!fam || !fam.activated_at || new Date(fam.activated_at) >= at) continue;
      const med = stateAt(aM.get(s.medication_id) || [], S.meds.find((m) => m.id === s.medication_id), at);
      if (!med || !med.active || med.kind !== "continuo" || !med.verified_at || (med.tablet_strength && !med.equivalence_confirmed_at)) continue;
      push(d, time, s.medication_id, null);
    }
  }
  for (const a of valid) {
    if (!a.schedule_id || seen.has(a.schedule_id + "|" + a.slot_date) || a.slot_date < first || a.slot_date > last) continue;
    push(a.slot_date, a.slot_time.slice(0, 5), a.medication_id, a);
  }
  slots.sort((x, y) => x.at - y.at || x.med.localeCompare(y.med));
  const count = (arr, st) => arr.filter((s) => s.status === st).length;
  const late = slots.filter((s) => s.status === "atraso");
  const people = new Map();
  for (const s of slots) if (s.adm) {
    const n = s.adm.given_by_name; if (!people.has(n)) people.set(n, { total: 0, ok: 0, atraso: 0, adiantado: 0 });
    const p = people.get(n); p.total++; p[s.status]++;
  }
  const byTime = new Map();
  for (const s of slots) { if (!byTime.has(s.time)) byTime.set(s.time, []); byTime.get(s.time).push(s); }
  const byMed = new Map();
  for (const s of slots) { if (!byMed.has(s.med)) byMed.set(s.med, []); byMed.get(s.med).push(s); }
  const days = new Map();
  for (const s of slots) { if (!days.has(s.date)) days.set(s.date, []); days.get(s.date).push(s); }
  const eventual = new Map();
  for (const a of valid) if (!a.schedule_id) {
    const m = S.meds.find((x) => x.id === a.medication_id) || { unit: a.unit };
    const k = medName(a.medication_id); if (!eventual.has(k)) eventual.set(k, { n: 0, q: 0, m }); const e = eventual.get(k); e.n++; e.q += Number(a.quantity);
  }
  return {
    slots, total: slots.length, ok: count(slots, "ok"), atraso: late.length, adiantado: count(slots, "adiantado"), sem: count(slots, "sem"),
    avgLate: late.length ? Math.round(late.reduce((t, s) => t + s.diff, 0) / late.length) : 0,
    maxLate: late.reduce((mx, s) => (s.diff > (mx?.diff || 0) ? s : mx), null),
    people: [...people.entries()].sort((a, b) => b[1].total - a[1].total),
    byTime: [...byTime.entries()].map(([t, arr]) => ({ t, total: arr.length, bad: arr.filter((s) => s.status !== "ok").length, late: count(arr, "atraso"), sem: count(arr, "sem") }))
      .sort((a, b) => a.t.localeCompare(b.t)),
    byMed: [...byMed.entries()].map(([m, arr]) => ({ m, total: arr.length, bad: arr.filter((s) => s.status !== "ok").length })).sort((a, b) => b.bad - a.bad || a.m.localeCompare(b.m)),
    days: [...days.entries()],
    eventual: [...eventual.entries()],
    corrections: adm.filter((a) => a.replaces_id).length,
    undone: adm.filter((a) => a.status === "anulado" && !String(a.void_reason || "").startsWith("Corrigido")).length,
  };
}
const pct = (n, t) => (t ? Math.round((n / t) * 100) : 0);
function diffText(s) {
  if (s.status === "sem") return "sem registro";
  const m = Math.abs(s.diff);
  if (s.status === "atraso") return `dado às ${hm(s.adm.given_at)}, ${dur(m * 60000)} de atraso`;
  if (s.status === "adiantado") return `dado às ${hm(s.adm.given_at)}, ${dur(m * 60000)} antes`;
  return `dado às ${hm(s.adm.given_at)}`;
}
function viewRelatorio() {
  const cur = ymOf(localDate());
  if (!S.rep || (!S.rep.loading && !S.rep.data && !S.rep.error)) S.rep = null;
  const ym = S.rep?.ym || S.repYm || cur;
  if (!S.rep || S.rep.ym !== ym) { S.rep = { ym, loading: true }; setTimeout(() => loadReport(ym), 0); }
  let h = pageHead("Relatório do mês");
  h += `<div class="monthbar noprint"><button class="back" data-act="repMonth" data-n="-1" aria-label="Mês anterior">‹</button>
    <b>${esc(monthName(ym))}</b>
    <button class="back" data-act="repMonth" data-n="1" aria-label="Próximo mês" ${ym >= cur ? "disabled" : ""}>›</button></div>
    <p class="printonly"><b>Relatório de ${esc(monthName(ym))}</b></p>`;
  if (S.rep.loading) return h + `<div class="spinner">Montando o relatório…</div>`;
  if (S.rep.error) return h + `<div class="card red">${esc(errText(S.rep.error))}<button class="btn ghost small" data-act="repMonth" data-n="0">Tentar de novo</button></div>`;
  const r = S.rep.data;
  if (!r.total && !r.eventual.length) {
    return h + `<div class="card muted">Nenhum horário previsto ${ym === cur ? "até agora neste mês" : "neste mês"}. O relatório começa a contar depois que o sistema é ativado.</div>`;
  }
  const bad = r.atraso + r.adiantado + r.sem;
  h += `<div class="card">
    <p class="small muted">${ym === cur ? "Até agora neste mês" : "No mês inteiro"}, foram ${r.total} horários de remédio.</p>
    <p class="stock-num" style="margin-top:6px;color:${pct(r.ok, r.total) >= 90 ? "var(--green)" : pct(r.ok, r.total) >= 70 ? "var(--ink)" : "var(--red)"}">${pct(r.ok, r.total)}% <span style="font-size:19px">no horário certo</span></p>
    <div class="stack" aria-hidden="true">
      <i style="width:${pct(r.ok, r.total)}%;background:var(--green)"></i><i style="width:${pct(r.atraso, r.total)}%;background:var(--amber)"></i>
      <i style="width:${pct(r.adiantado, r.total)}%;background:var(--blue)"></i><i style="width:${pct(r.sem, r.total)}%;background:var(--red)"></i></div>
    <div class="legend">
      <p><span class="sw" style="background:var(--green)"></span><b>${r.ok}</b> no horário <span class="muted small">(até ${TOL_MIN} min de diferença)</span></p>
      <p><span class="sw" style="background:var(--amber)"></span><b>${r.atraso}</b> com atraso${r.atraso ? ` <span class="muted small">(em média ${dur(r.avgLate * 60000)})</span>` : ""}</p>
      <p><span class="sw" style="background:var(--blue)"></span><b>${r.adiantado}</b> adiantados <span class="muted small">(mais de ${TOL_MIN} min antes)</span></p>
      <p><span class="sw" style="background:var(--red)"></span><b>${r.sem}</b> sem registro</p>
    </div></div>`;
  // recado
  const worst = [...r.byTime].sort((a, b) => b.bad - a.bad)[0];
  let tip;
  if (!bad) tip = `<b>Parabéns!</b> Todos os horários foram registrados no horário certo. Continue assim.`;
  else {
    const parts = [];
    if (worst && worst.bad) parts.push(`O horário que mais precisou de atenção foi o das <b>${esc(worst.t)}</b>: ${worst.bad} de ${worst.total} fora do horário ou sem registro.`);
    if (r.maxLate) parts.push(`O maior atraso foi em ${weekday(r.maxLate.date)}, ${shortDate(r.maxLate.date)}: ${esc(r.maxLate.med)} das ${esc(r.maxLate.time)}, ${dur(r.maxLate.diff * 60000)} depois.`);
    if (r.sem) parts.push(`Quando der o remédio, toque em “Já administrei” na hora. Assim o horário não fica sem registro.`);
    parts.push(`Uma ajuda: deixar um alarme no relógio do celular nos horários que mais atrasaram.`);
    tip = parts.join(" ");
  }
  h += `<div class="card ${bad ? "amber" : "green"}">${tip}</div>`;
  if (r.people.length) {
    h += `<h2 class="sec">Por pessoa</h2><div class="card">${r.people.map(([n, p]) => `<div class="rowline">
      <span><b>${esc(n)}</b><span class="sub">${p.total} registros</span></span>
      <span class="right">${p.ok} no horário${p.atraso ? ` · <b style="color:var(--red)">${p.atraso} com atraso</b>` : ""}${p.adiantado ? ` · ${p.adiantado} adiantados` : ""}</span></div>`).join("")}</div>`;
  }
  h += `<h2 class="sec">Por horário</h2><div class="card">${r.byTime.map((t) => `<div class="rowline">
    <span><b style="font-size:22px">${esc(t.t)}</b><span class="sub">${t.total} vezes</span></span>
    <span class="right">${t.bad ? `${t.late ? `<b style="color:var(--red)">${t.late} com atraso</b>` : ""}${t.late && t.sem ? " · " : ""}${t.sem ? `${t.sem} sem registro` : ""}${t.bad - t.late - t.sem ? ` · ${t.bad - t.late - t.sem} adiantados` : ""}` : `<span style="color:var(--green)">✓ tudo no horário</span>`}</span></div>`).join("")}</div>`;
  h += `<h2 class="sec">Por remédio</h2><div class="card">${r.byMed.map((m) => `<div class="rowline"><span>${esc(m.m)}</span>
    <span class="right">${m.bad ? `<b style="color:var(--red)">${m.bad} de ${m.total} fora</b>` : `<span style="color:var(--green)">✓ ${m.total} de ${m.total}</span>`}</span></div>`).join("")}</div>`;
  // dia a dia
  const goodDays = r.days.filter(([, arr]) => arr.every((s) => s.status === "ok")).length;
  h += `<h2 class="sec">Dia a dia</h2>`;
  if (goodDays) h += `<p class="small" style="color:var(--green);font-weight:700">✓ ${goodDays} ${goodDays === 1 ? "dia" : "dias"} com todos os horários certos.</p>`;
  for (const [d, arr] of r.days) {
    const probs = arr.filter((s) => s.status !== "ok");
    if (!probs.length) continue;
    h += `<p class="hist-day">${esc(weekday(d))}, ${shortDate(d)}</p>`;
    for (const s of probs) h += `<div class="hist"><div><b>${esc(s.time)}</b> · ${esc(s.med)}</div>
      <div class="meta" style="color:${s.status === "sem" || s.status === "atraso" ? "var(--red)" : "inherit"}">${esc(diffText(s))}${s.adm ? ` · por ${esc(s.adm.given_by_name)}` : ""}</div></div>`;
  }
  if (r.eventual.length) {
    h += `<h2 class="sec">Remédios “se necessário” no mês</h2><div class="card">${r.eventual.map(([k, e]) =>
      `<div class="rowline"><span>${esc(k)}</span><span class="right"><b>${e.n} ${e.n === 1 ? "vez" : "vezes"}</b> · ${esc(qty(e.m, e.q))} no total</span></div>`).join("")}</div>`;
  }
  h += `<p class="small muted" style="margin-top:16px">${r.corrections ? `${r.corrections} ${r.corrections === 1 ? "registro foi corrigido" : "registros foram corrigidos"}. ` : ""}${r.undone ? `${r.undone} ${r.undone === 1 ? "registro foi desfeito" : "registros foram desfeitos"}. ` : ""}
    “Sem registro” quer dizer que ninguém tocou em “Já administrei” naquele horário. Não quer dizer, por si só, que o remédio não foi dado. Este relatório não substitui a orientação da equipe de saúde.</p>
    <div class="noprint"><button class="btn primary" data-act="repPrint">Imprimir ou salvar em PDF</button>
    <button class="btn ghost small" data-act="repCsv">Baixar planilha do mês</button></div>`;
  return h;
}
function exportReportCsv() {
  const r = S.rep?.data; if (!r) return;
  const cell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lbl = { ok: "No horário", atraso: "Com atraso", adiantado: "Adiantado", sem: "Sem registro" };
  let csv = "﻿DATA;HORÁRIO PREVISTO;REMÉDIO;REGISTRADO ÀS;DIFERENÇA (MIN);SITUAÇÃO;QUEM\n";
  for (const s of r.slots) csv += [shortDate(s.date) + "/" + s.date.slice(0, 4), s.time, s.med, s.adm ? hm(s.adm.given_at) : "", s.diff ?? "", lbl[s.status], s.adm?.given_by_name || ""].map(cell).join(";") + "\n";
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `relatorio-remedios-${S.rep.ym}.csv`; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
function reportCard() {
  const today = localDate();
  if (Number(today.slice(8, 10)) > 7 || !S.family.activated_at) return "";
  const prev = shiftMonth(ymOf(today), -1);
  if (new Date(S.family.activated_at) >= zoned(`${ymOf(today)}-01`, "00:00") && !S.family.activated_at.startsWith(prev)) {
    // sistema ativado só neste mês: ainda não há relatório anterior
    const act = localDate(new Date(S.family.activated_at)); if (act >= `${ymOf(today)}-01`) return "";
  }
  let hidden = false; try { hidden = localStorage.getItem("relatorioVisto") === prev; } catch {}
  if (hidden) return "";
  return `<div class="card green"><b>O relatório de ${esc(monthOnly(prev))} está pronto.</b>
    <p class="small" style="margin-top:4px">Veja como foram os horários do mês e onde dá para melhorar.</p>
    <button class="btn primary small" data-act="openReport" data-ym="${prev}">Ver relatório</button>
    <button class="link" data-act="hideReport" data-ym="${prev}">Ocultar</button></div>`;
}

const PAGES = { relatorio: viewRelatorio, eventuais: viewEventuais, conferencia: viewConferencia, notificacoes: viewNotificacoes, familiares: viewFamiliares, historico: viewHistorico, ajuda: viewAjuda };

/* ================= folhas (modais) ================= */
let sheetClose = null;
function openSheet(html, { locked = false, onClose } = {}) {
  $sheet.innerHTML = `<div class="shade" ${locked ? "" : 'data-act="closeSheet"'}></div><div class="panel"><div class="in">${html}</div></div>`;
  $sheet.classList.add("open");
  sheetClose = onClose || null;
  if (!locked) history.pushState({ sheet: 1 }, "");
}
function closeSheet(fromPop = false) {
  if (!$sheet.classList.contains("open")) return;
  $sheet.classList.remove("open"); $sheet.innerHTML = "";
  const cb = sheetClose; sheetClose = null; if (cb) cb();
  if (!fromPop && history.state?.sheet) history.back();
  render();
}
const q = (sel) => $sheet.querySelector(sel);
function sheetErr(msg) { const e = q(".err"); if (e) e.textContent = msg; }
function sheetBusy(on, label) {
  const b = q("[data-save]"); if (!b) return;
  b.disabled = on; if (on) { b.dataset.label = b.textContent; b.textContent = label || "Salvando…"; } else if (b.dataset.label) b.textContent = b.dataset.label;
}

function sheetName(locked = false) {
  openSheet(`<h2>Como você se chama?</h2>
    <p class="muted" style="margin-top:6px">Seu nome aparece em cada remédio que você registrar, para a outra pessoa saber quem deu.</p>
    <label class="f">Seu nome<input class="i" id="nm" value="${esc(S.me.display_name || "")}" maxlength="30" autocomplete="given-name"></label>
    <p class="err"></p><button class="btn primary" data-act="saveName" data-save>Salvar</button>
    ${locked ? "" : `<button class="btn ghost" data-act="closeSheet">Cancelar</button>`}`, { locked });
}

function sheetEarly(s) {
  openSheet(`<h2>Ainda não é a hora</h2>
    <p style="margin-top:8px">${medTitle(s.med)} está marcado para <b>${esc(s.time)}</b> (${cdText(s.at)}).</p>
    <p style="margin-top:8px">Registrar agora mesmo assim?</p>
    <button class="btn give" data-act="giveConfirmEarly" data-key="${s.key}">Sim, já administrei</button>
    <button class="btn ghost" data-act="closeSheet">Não, voltar</button>`);
}

function sheetEventual(m, force = false) {
  const last = lastGiven(m);
  const since = last ? Date.now() - new Date(last.given_at) : null;
  const within = m.interval_confirmed && m.min_interval_hours && last && since < m.min_interval_hours * 3600e3;
  const range = m.dose_min && m.dose_max;
  const opts = range ? Array.from({ length: Math.floor((m.dose_max - m.dose_min) / 5) + 1 }, (_, i) => Number(m.dose_min) + i * 5) : null;
  openSheet(`<h2>Registrar: ${esc(m.name)} ${esc(m.strength)}</h2>
    <p style="margin-top:8px"><b>${esc(m.condition_text || "")}</b></p>
    ${last ? `<p class="small" style="margin-top:8px">Última vez: ${esc(whenText(last.given_at))} por ${esc(last.given_by_name)}, há ${dur(since)}.</p>` : ""}
    ${within ? `<div class="card red small"><b>Atenção:</b> a receita indica intervalo de ${num(m.min_interval_hours)} horas e faz só ${dur(since)}. Se tiver dúvida, fale com a equipe de saúde antes.</div>` : ""}
    <label class="f">Quanto foi dado? <span class="hint">${range ? `receita: ${num(m.dose_min)} a ${num(m.dose_max)} mL` : `receita: ${esc(qty(m, m.dose_qty))}`}</span></label>
    ${range ? `<div class="chips" id="qtyChips">${opts.map((v) => `<button class="chip" data-act="pickQty" data-v="${v}" aria-pressed="false">${num(v)} mL</button>`).join("")}</div>
      <input type="hidden" id="qty" value="">`
      : `<input class="i big" id="qty" type="number" inputmode="decimal" min="0.5" step="0.5" value="${esc(m.dose_qty)}">`}
    <label class="f">Que horas foi dado?<input class="i" id="when" type="time" value="${hm(new Date())}"></label>
    <p class="err"></p>
    <button class="btn ${within ? "danger" : "give"}" data-act="saveEventual" data-id="${m.id}" data-force="${force ? 1 : 0}" data-save>${within ? "Registrar mesmo assim" : "Confirmar que administrei"}</button>
    <button class="btn ghost" data-act="closeSheet">Cancelar</button>`);
}

function sheetFix(a) {
  const m = S.meds.find((x) => x.id === a.medication_id);
  if (a.status === "anulado") { toast("Este registro já foi desfeito."); return; }
  openSheet(`<h2>Corrigir registro</h2>
    <p style="margin-top:8px">${medTitle(m)}<br>${esc(qty(m, a.quantity))} · ${esc(whenText(a.given_at))} · por ${esc(a.given_by_name)}</p>
    <div class="card">
      <b>Não foi dado?</b>
      <div class="chips">${["Toquei sem querer", "Registro em dobro", "Não foi administrado"].map((r) => `<button class="chip" data-act="pickReason" data-v="${r}" aria-pressed="false">${r}</button>`).join("")}</div>
      <button class="btn danger small" data-act="voidAdm" data-id="${a.id}" data-save>Desfazer este registro</button>
    </div>
    <div class="card"><b>Foi dado, mas a hora ou a quantidade está errada?</b>
      <label class="f">Hora certa<input class="i" id="fixWhen" type="time" value="${hm(a.given_at)}"></label>
      <label class="f">Quantidade certa (${unitWord(m)})<input class="i" id="fixQty" type="number" inputmode="decimal" min="0.5" step="0.5" value="${esc(a.quantity)}"></label>
      <button class="btn primary small" data-act="correctAdm" data-id="${a.id}">Salvar correção</button></div>
    <p class="small muted">O registro antigo fica guardado no histórico, marcado como corrigido. O estoque é ajustado automaticamente.</p>
    <p class="err"></p>
    <button class="btn ghost" data-act="closeSheet">Fechar</button>`);
}

function sheetStock(m, mode) {
  const add = mode === "compra";
  const chips = m.unit === "mL" ? [100, 120, 200, 250] : [10, 14, 20, 28, 30, 60];
  openSheet(`<h2>${add ? "Adicionar estoque" : "Quantos tem agora?"}</h2>
    <p style="margin-top:6px">${medTitle(m)}${m.tablet_strength ? `<br><span class="small">comprimidos de <b>${esc(m.tablet_strength)}</b></span>` : ""}</p>
    <p class="small muted" style="margin-top:6px">A caixa diz quantos vêm nela, mas digite só o que realmente tem ou chegou.</p>
    <p class="small muted" style="margin-top:6px">${add ? `Digite quantos ${unitWord(m)} chegaram (veja na caixa ou no frasco).` : `Conte o que tem em casa e digite o total de ${unitWord(m)}.`}</p>
    ${m.prescription_note ? `<p class="small muted">${esc(m.prescription_note)}</p>` : ""}
    <input class="i big" id="stk" type="number" inputmode="decimal" min="0" step="${m.unit === "mL" ? 1 : 0.5}" value="" placeholder="0" style="margin-top:14px">
    ${add ? `<div class="chips">${chips.map((v) => `<button class="chip" data-act="stkChip" data-v="${v}" aria-pressed="false">${v}</button>`).join("")}</div>` : ""}
    <p class="small" id="stkPreview" style="margin-top:10px"></p>
    <p class="err"></p>
    <button class="btn primary" data-act="saveStock" data-id="${m.id}" data-mode="${mode}" data-save>Salvar</button>
    <button class="btn ghost" data-act="closeSheet">Cancelar</button>`);
  const inp = q("#stk");
  const prev = () => {
    const v = Number(inp.value);
    q("#stkPreview").textContent = inp.value === "" ? "" : add ? `Vai ficar com ${num(Math.max(0, Number(m.stock || 0)) + v)} ${unitWord(m)}.` : `O estoque passa a ser ${num(v)} ${unitWord(m)}.`;
  };
  inp.addEventListener("input", prev);
  setTimeout(() => inp.focus(), 50);
}

function sheetMed(m) {
  const sch = S.schedules.filter((s) => s.medication_id === m.id).sort((a, b) => a.time_of_day.localeCompare(b.time_of_day));
  const cont = m.kind === "continuo";
  const n = Math.max(sch.length, cont ? m.times_per_day || 1 : 0);
  const rows = Array.from({ length: n }, (_, i) => sch[i] ? { id: sch[i].id, t: sch[i].time_of_day.slice(0, 5) } : { id: "", t: "" });
  openSheet(`<h2>${esc(m.name)} ${esc(m.strength)}</h2>
    ${m.pending_note ? `<div class="card amber small"><b>Para conferir:</b> ${esc(m.pending_note)}</div>` : ""}
    ${m.prescription_note ? `<p class="small muted">${esc(m.prescription_note)}</p>` : ""}
    <label class="f">Nome<input class="i" id="mName" value="${esc(m.name)}"></label>
    <label class="f">Dosagem prescrita pelo médico <span class="hint">dose de cada administração, como na receita</span><input class="i" id="mStr" value="${esc(m.strength)}"></label>
    ${m.unit === "comprimido" ? `<label class="f">Dosagem de cada comprimido que vocês têm <span class="hint">deixe vazio se for igual à receita</span><input class="i" id="mTab" value="${esc(m.tablet_strength || "")}" placeholder="igual à receita"></label>` : ""}
    ${m.unit === "mL" && m.dose_min ? `
      <div class="btn-row"><label class="f" style="flex:1">Mínimo (mL)<input class="i" id="mMin" type="number" inputmode="decimal" value="${esc(m.dose_min)}"></label>
      <label class="f" style="flex:1">Máximo (mL)<input class="i" id="mMax" type="number" inputmode="decimal" value="${esc(m.dose_max)}"></label></div>`
      : `<label class="f">Quantidade por vez (${unitWord(m)})<input class="i" id="mQty" type="number" inputmode="decimal" min="0.5" step="0.5" value="${esc(m.dose_qty)}"></label>`}
    ${m.tablet_strength || m.equivalence_note ? `<div class="card ${m.equivalence_confirmed_at ? "green" : "red"} small" style="margin-top:16px">
      <b>Troca de comprimido</b>${m.equivalence_note ? `<p style="margin-top:6px">${esc(m.equivalence_note)}</p>` : ""}
      <label class="check"><input type="checkbox" id="mEq" ${m.equivalence_confirmed_at ? "checked" : ""}><span>O <b>médico ou farmacêutico validou</b> dar ${esc(tabsOf(m, m.dose_qty))} por vez para a dose prescrita, e a forma de dar pela sonda.</span></label>
      ${m.equivalence_confirmed_at ? `<p class="muted" style="margin-top:6px">Validado, registrado por ${esc(m.equivalence_confirmed_by_name || "")} ${esc(whenText(m.equivalence_confirmed_at))}.</p>` : `<p style="margin-top:6px">Enquanto não for validado, este remédio não aparece em Hoje nem desconta estoque.</p>`}
    </div>` : ""}
    <label class="f">Frequência escrita na receita<input class="i" id="mFreq" value="${esc(m.frequency_text)}"></label>
    ${cont ? `<label class="f">Horários exatos <span class="hint">combinados com a equipe de saúde</span></label>
      <div class="times" id="times">${rows.map((r) => timeRow(r)).join("")}</div>
      <button class="btn soft small" data-act="addTime">+ Incluir outro horário</button>
      ${/12/.test(m.frequency_text) ? `<p class="small muted" style="margin-top:6px">De 12 em 12 horas: ao preencher o primeiro horário, o segundo é sugerido com 12 horas de diferença. Confira antes de salvar.</p>` : ""}`
    : `<label class="f">Quando usar<input class="i" id="mCond" value="${esc(m.condition_text || "")}"></label>
      <label class="f">Intervalo mínimo entre doses (horas)<input class="i" id="mInt" type="number" inputmode="decimal" min="1" value="${esc(m.min_interval_hours ?? "")}"></label>
      <label class="check"><input type="checkbox" id="mIntOk" ${m.interval_confirmed ? "checked" : ""}><span>Confirmei este intervalo com a equipe de saúde</span></label>`}
    <label class="f">Como dar pela sonda <span class="hint">orientação da equipe (triturar? diluir em quê? lavar a sonda?)</span>
      <textarea class="i" id="mNotes" maxlength="400">${esc(m.admin_notes || "")}</textarea></label>
    <label class="f">Avisar para comprar quando tiver (${unitWord(m)}) ou menos<input class="i" id="mThr" type="number" inputmode="decimal" min="0" value="${esc(m.reorder_threshold)}"></label>
    <label class="check"><input type="checkbox" id="mOk" ${m.verified_at ? "checked" : ""}><span><b>Conferi</b> nome, dosagem, quantidade e ${cont ? "horários" : "condição de uso"} com a receita e a embalagem.</span></label>
    ${m.verified_at ? `<p class="small muted">Conferido por ${esc(m.verified_by_name || "")} ${esc(whenText(m.verified_at))}.</p>` : ""}
    <p class="err"></p>
    <button class="btn primary" data-act="saveMed" data-id="${m.id}" data-save>Salvar</button>
    <button class="btn ghost" data-act="closeSheet">Cancelar</button>
    <button class="link" data-act="toggleActive" data-id="${m.id}">${m.active ? "Suspender este remédio (o médico tirou da receita)" : "Voltar a usar este remédio"}</button>`);
  wireTimes(m);
}
function timeRow(r) {
  return `<div class="row" data-sid="${esc(r.id)}"><input class="i" type="time" value="${esc(r.t)}"><button data-act="rmTime" aria-label="Remover horário">✕</button></div>`;
}
function wireTimes(m) {
  const box = q("#times"); if (!box) return;
  box.addEventListener("change", (e) => {
    if (!/12/.test(m.frequency_text)) return;
    const ins = [...box.querySelectorAll("input")];
    if (ins.length === 2 && e.target === ins[0] && ins[0].value && !ins[1].value) {
      const [h, mi] = ins[0].value.split(":").map(Number);
      ins[1].value = `${String((h + 12) % 24).padStart(2, "0")}:${String(mi).padStart(2, "0")}`;
    }
  });
}

/* ================= ações ================= */
const A = {
  tab: (d) => { S.page = null; S.tab = d.tab; render(); scrollTo(0, 0); },
  page: (d) => { S.page = d.page; if (d.page === "historico") S.hist = null; if (d.page === "relatorio") { S.rep = null; S.repYm = null; } history.pushState({ page: d.page }, ""); render(); scrollTo(0, 0); },
  back: () => history.back(),
  reload: () => { S.loading = !S.family; render(); reload(); subscribe(); },
  closeSheet: () => closeSheet(),
  logout: async () => { await sb.auth.signOut(); location.reload(); },
  install: async () => { if (S.installEvt) { S.installEvt.prompt(); await S.installEvt.userChoice; S.installEvt = null; render(); } },

  give: (d) => give(d.key),
  giveConfirmEarly: (d) => { closeSheet(); give(d.key, true); },
  fix: (d) => { const a = S.admins.find((x) => x.id === d.id) || S.hist?.adm?.find((x) => x.id === d.id); if (a) sheetFix(a); },
  giveEventual: (d) => sheetEventual(S.meds.find((m) => m.id === d.id)),
  pickQty: (d, el) => { $sheet.querySelectorAll("#qtyChips .chip").forEach((c) => c.setAttribute("aria-pressed", c === el)); q("#qty").value = d.v; },
  pickReason: (d, el) => { $sheet.querySelectorAll("[data-act=pickReason]").forEach((c) => c.setAttribute("aria-pressed", c === el)); },
  stkChip: (d, el) => { const i = q("#stk"); i.value = d.v; i.dispatchEvent(new Event("input")); $sheet.querySelectorAll("[data-act=stkChip]").forEach((c) => c.setAttribute("aria-pressed", c === el)); },

  saveEventual: async (d) => {
    const m = S.meds.find((x) => x.id === d.id);
    const v = Number(q("#qty").value), t = q("#when").value;
    if (!v || v <= 0) return sheetErr("Escolha a quantidade que foi dada.");
    if (m.dose_max && v > Number(m.dose_max)) return sheetErr("Quantidade acima da máxima da receita.");
    if (!t) return sheetErr("Informe a hora.");
    let at = zoned(localDate(), t);
    if (at > Date.now() + 5 * 60e3) return sheetErr("Essa hora ainda não chegou. Confira o horário.");
    const key = q("[data-save]").dataset.ck || (q("[data-save]").dataset.ck = uuid());
    sheetBusy(true);
    const { data, error } = await rpc("record_administration", { p_medication: m.id, p_quantity: v, p_client_key: key, p_given_at: at.toISOString(), p_force: d.force === "1" });
    sheetBusy(false);
    if (error) {
      if (String(error.message).includes("registro_recente")) {
        sheetErr("Já houve um registro deste remédio há poucos minutos (talvez pela outra pessoa). Se foi mesmo outra dose, toque de novo.");
        const b = q("[data-save]"); b.dataset.force = "1"; b.dataset.ck = uuid(); b.textContent = "Sim, foi outra dose. Registrar"; return;
      }
      return sheetErr(errText(error));
    }
    upsertAdm(data); closeSheet(); toastUndo(data, m);
  },
  voidAdm: async (d) => {
    const r = $sheet.querySelector("[data-act=pickReason][aria-pressed=true]");
    if (!r) return sheetErr("Escolha o motivo acima.");
    sheetBusy(true);
    const { data, error } = await rpc("void_administration", { p_id: d.id, p_reason: r.dataset.v });
    sheetBusy(false);
    if (error) return sheetErr(errText(error));
    upsertAdm(data); closeSheet(); toast("Registro desfeito. O estoque foi devolvido."); reloadSoon(); if (S.hist) loadHistory();
  },
  correctAdm: async (d) => {
    const a = S.admins.find((x) => x.id === d.id) || S.hist?.adm?.find((x) => x.id === d.id);
    const t = q("#fixWhen").value, v = Number(q("#fixQty").value);
    if (!t || !v || v <= 0) return sheetErr("Preencha a hora e a quantidade.");
    let at = zoned(localDate(new Date(a.given_at)), t);
    if (at > Date.now() + 5 * 60e3) at = zoned(addDays(localDate(new Date(a.given_at)), -1), t);
    if (Math.abs(at - new Date(a.given_at)) < 60e3 && v === Number(a.quantity)) return sheetErr("Nada mudou.");
    const b = $sheet.querySelector("[data-act=correctAdm]"); b.disabled = true; b.textContent = "Salvando…";
    const { error } = await rpc("correct_administration", { p_id: a.id, p_quantity: v, p_given_at: at.toISOString(), p_reason: "hora/quantidade corrigida", p_client_key: b.dataset.ck || (b.dataset.ck = uuid()) });
    b.disabled = false; b.textContent = "Salvar correção";
    if (error) return sheetErr(errText(error));
    closeSheet(); toast("Correção salva. O registro antigo ficou no histórico."); reloadSoon(50); if (S.hist) loadHistory();
  },
  stockAdd: (d) => sheetStock(S.meds.find((m) => m.id === d.id), "compra"),
  stockSet: (d) => sheetStock(S.meds.find((m) => m.id === d.id), "ajuste"),
  saveStock: async (d) => {
    const raw = q("#stk").value; const v = Number(raw);
    if (raw === "" || !(v >= 0)) return sheetErr("Digite um número.");
    if (d.mode === "compra" && v <= 0) return sheetErr("Digite quantos chegaram.");
    if (v > 5000) return sheetErr("Número muito alto. Confira.");
    sheetBusy(true);
    const { data, error } = await rpc("change_stock", { p_medication: d.id, p_mode: d.mode, p_value: v, p_note: null });
    sheetBusy(false);
    if (error) return sheetErr(errText(error));
    const i = S.meds.findIndex((m) => m.id === d.id); if (i >= 0) S.meds[i] = data;
    closeSheet(); toast(`Estoque salvo: ${qty(data, data.stock)}.`);
  },

  name: () => sheetName(false),
  saveName: async () => {
    const v = q("#nm").value.trim();
    if (v.length < 2) return sheetErr("Escreva seu nome.");
    sheetBusy(true);
    const { error } = await sb.from("members").update({ display_name: v }).eq("user_id", S.me.user_id);
    sheetBusy(false);
    if (error) return sheetErr(errText(error));
    S.me.display_name = v; closeSheet(); reloadSoon(); toast("Nome salvo.");
  },
  password: () => openSheet(`<h2>Trocar minha senha</h2>
      <label class="f">Nova senha <span class="hint">pelo menos 8 letras ou números</span><input class="i" id="pw1" type="password" autocomplete="new-password"></label>
      <label class="f">Repita a nova senha<input class="i" id="pw2" type="password" autocomplete="new-password"></label>
      <p class="err"></p><button class="btn primary" data-act="savePw" data-save>Salvar</button><button class="btn ghost" data-act="closeSheet">Cancelar</button>`),
  savePw: async () => {
    const a = q("#pw1").value, b = q("#pw2").value;
    if (a.length < 8) return sheetErr("A senha precisa ter pelo menos 8 caracteres.");
    if (a !== b) return sheetErr("As duas senhas estão diferentes.");
    sheetBusy(true);
    const { error } = await sb.auth.updateUser({ password: a });
    sheetBusy(false);
    if (error) return sheetErr(errText(error));
    closeSheet(); toast("Senha trocada.");
  },
  saveTz: async () => {
    const v = document.getElementById("tzSel").value;
    const { error } = await sb.from("families").update({ timezone: v }).eq("id", S.family.id);
    if (error) return toast(errText(error), true);
    S.family.timezone = v; render(); toast("Fuso horário salvo.");
  },
  histTab: (d) => { S.histTab = d.k; render(); },
  repMonth: (d) => { const ym = shiftMonth(S.rep?.ym || ymOf(localDate()), Number(d.n)); if (ym > ymOf(localDate())) return; S.repYm = ym; S.rep = { ym, loading: true }; render(); loadReport(ym); },
  repPrint: () => window.print(),
  repCsv: () => exportReportCsv(),
  openReport: (d) => { S.repYm = d.ym; S.rep = null; S.page = "relatorio"; history.pushState({ page: "relatorio" }, ""); render(); scrollTo(0, 0); },
  hideReport: (d) => { try { localStorage.setItem("relatorioVisto", d.ym); } catch {} render(); },
  export: () => exportCsv(),

  editMed: (d) => sheetMed(S.meds.find((m) => m.id === d.id)),
  addTime: () => { const box = q("#times"); box.insertAdjacentHTML("beforeend", timeRow({ id: "", t: "" })); box.lastElementChild.querySelector("input").focus(); },
  rmTime: (d, el) => el.closest(".row").remove(),
  saveMed: (d) => saveMed(d.id),
  toggleActive: async (d) => {
    const m = S.meds.find((x) => x.id === d.id);
    const ok = m.active ? confirm(`Suspender ${m.name}? Ele sai da tela Hoje e dos lembretes. O histórico continua guardado.`) : true;
    if (!ok) return;
    const { error } = await sb.from("medications").update({ active: !m.active }).eq("id", m.id);
    if (error) return sheetErr(errText(error));
    closeSheet(); reloadSoon(50); toast(m.active ? "Remédio suspenso." : "Remédio voltou para a lista.");
  },
  gastro: async (d) => {
    const on = d.v === "1";
    const { error } = await sb.from("families").update({ gastro_ack_at: on ? new Date().toISOString() : null, gastro_ack_by_name: on ? myName() : null }).eq("id", S.family.id);
    if (error) return toast(errText(error), true);
    reloadSoon(20);
  },
  activate: async (d) => {
    const on = d.v === "1";
    if (!on && !confirm("Pausar o sistema? Os horários somem da tela Hoje e os lembretes param até ativar de novo.")) return;
    const { error } = await rpc("set_activation", { p_active: on });
    if (error) return toast(errText(error), true);
    await reload(); toast(on ? "Sistema ativado. Os horários já aparecem em Hoje." : "Sistema pausado.");
    if (on) { S.page = null; S.tab = "hoje"; render(); }
  },

  pushOn: () => enablePush(),
  pushOff: () => disablePush(),
  pushTest: () => testPush(),
};

async function give(key, confirmedEarly = false) {
  const s = todaySlots().find((x) => x.key === key);
  if (!s || s.adm || S.busy.has(key)) return;
  if (!confirmedEarly && s.at.getTime() - Date.now() > 2 * 3600e3) return sheetEarly(s);
  const ck = S.pendingKeys.get(key) || uuid(); S.pendingKeys.set(key, ck);
  S.busy.add(key); S.failed.delete(key); render();
  const { data, error } = await rpc("record_administration", { p_medication: s.med.id, p_quantity: Number(s.med.dose_qty), p_client_key: ck, p_schedule: s.sch.id, p_slot_date: s.date });
  S.busy.delete(key);
  if (error) {
    if (isNetwork(error)) { S.failed.set(key, "NÃO FOI SALVO: sem conexão. Toque para tentar de novo."); render(); toast("Não foi salvo. Verifique a internet.", true); return; }
    S.pendingKeys.delete(key); toast(errText(error), true); await reload(); return;
  }
  S.pendingKeys.delete(key); upsertAdm(data); render(); toastUndo(data, s.med);
  if ("vibrate" in navigator) navigator.vibrate(60);
}
function upsertAdm(row) { const i = S.admins.findIndex((a) => a.id === row.id); if (i >= 0) S.admins[i] = row; else S.admins.unshift(row); }

async function saveMed(id) {
  const m = S.meds.find((x) => x.id === id);
  const val = (s) => q(s)?.value?.trim();
  const upd = { name: val("#mName"), strength: val("#mStr"), frequency_text: val("#mFreq"), admin_notes: val("#mNotes") || null, reorder_threshold: Number(val("#mThr")) };
  if (!upd.name || !upd.strength || !upd.frequency_text) return sheetErr("Preencha nome, dosagem e frequência.");
  if (!(upd.reorder_threshold >= 0)) return sheetErr("Limite de compra inválido.");
  if (q("#mQty")) { upd.dose_qty = Number(val("#mQty")); if (!(upd.dose_qty > 0)) return sheetErr("Quantidade por vez inválida."); }
  if (q("#mMin")) {
    upd.dose_min = Number(val("#mMin")); upd.dose_max = Number(val("#mMax"));
    if (!(upd.dose_min > 0) || !(upd.dose_max >= upd.dose_min)) return sheetErr("Confira mínimo e máximo.");
    upd.dose_qty = upd.dose_min;
  }
  let times = [];
  if (m.kind === "continuo") {
    times = [...$sheet.querySelectorAll("#times .row")].map((r) => ({ id: r.dataset.sid, t: r.querySelector("input").value }));
    const filled = times.filter((t) => t.t);
    if (new Set(filled.map((t) => t.t)).size !== filled.length) return sheetErr("Há horários repetidos.");
    if (q("#mOk").checked && !filled.length) return sheetErr("Coloque pelo menos um horário antes de marcar como conferido.");
    upd.times_per_day = filled.length || m.times_per_day;
  } else {
    upd.condition_text = val("#mCond") || null;
    const iv = val("#mInt"); upd.min_interval_hours = iv ? Number(iv) : null;
    if (iv && !(upd.min_interval_hours > 0)) return sheetErr("Intervalo inválido.");
    upd.interval_confirmed = q("#mIntOk").checked;
  }
  if (q("#mTab")) upd.tablet_strength = val("#mTab") || null;
  const eqBox = q("#mEq");
  const eqChanged = ["tablet_strength", "dose_qty", "strength"].some((k) => k in upd && String(upd[k] ?? "") !== String(m[k] ?? ""));
  if (upd.tablet_strength) {
    if (eqBox && eqBox.checked && !(m.equivalence_confirmed_at && eqChanged)) {
      upd.equivalence_confirmed_at = m.equivalence_confirmed_at && !eqChanged ? m.equivalence_confirmed_at : new Date().toISOString();
      upd.equivalence_confirmed_by_name = m.equivalence_confirmed_at && !eqChanged ? m.equivalence_confirmed_by_name : myName();
    } else { upd.equivalence_confirmed_at = null; upd.equivalence_confirmed_by_name = null; }
  }
  const ok = q("#mOk").checked;
  upd.verified_at = ok ? (m.verified_at || new Date().toISOString()) : null;
  upd.verified_by_name = ok ? (m.verified_at ? m.verified_by_name : myName()) : null;
  const changed = ["name", "strength", "dose_qty", "dose_min", "dose_max", "frequency_text", "condition_text", "min_interval_hours"].some((k) => k in upd && String(upd[k] ?? "") !== String(m[k] ?? ""));
  if (ok && changed) { upd.verified_at = new Date().toISOString(); upd.verified_by_name = myName(); }
  sheetBusy(true);
  try {
    const r = await sb.from("medications").update(upd).eq("id", id);
    if (r.error) throw r.error;
    if (m.kind === "continuo") {
      const existing = S.schedules.filter((s) => s.medication_id === id);
      for (const s of existing) {
        const t = times.find((x) => x.id === s.id);
        if (!t || !t.t) { const x = await sb.from("schedules").update({ active: false }).eq("id", s.id); if (x.error) throw x.error; }
        else if (t.t !== s.time_of_day.slice(0, 5)) { const x = await sb.from("schedules").update({ time_of_day: t.t }).eq("id", s.id); if (x.error) throw x.error; }
      }
      const fresh = times.filter((t) => !t.id && t.t);
      if (fresh.length) { const x = await sb.from("schedules").insert(fresh.map((t) => ({ family_id: S.family.id, medication_id: id, time_of_day: t.t }))); if (x.error) throw x.error; }
    }
  } catch (e) { sheetBusy(false); return sheetErr(errText(e)); }
  sheetBusy(false); closeSheet(); await reload();
  toast(upd.tablet_strength && m.equivalence_confirmed_at && eqChanged ? "Salvo. Como a troca de comprimido mudou, a validação precisa ser marcada de novo." : "Salvo.");
}

/* ================= avisos ================= */
let toastTimer = null;
function toast(msg, bad = false, action) {
  clearTimeout(toastTimer);
  $toast.innerHTML = `<div class="t ${bad ? "bad" : ""}"><span>${esc(msg)}</span>${action ? `<button id="toastAct">${esc(action.label)}</button>` : ""}</div>`;
  if (action) document.getElementById("toastAct").onclick = action.run;
  toastTimer = setTimeout(() => ($toast.innerHTML = ""), action ? 15000 : bad ? 9000 : 4500);
}
function toastUndo(adm, m) {
  toast(`Registrado: ${m.name} · ${tabsOf(m, adm.quantity)}`, false, {
    label: "Desfazer",
    run: async () => {
      $toast.innerHTML = "";
      const { data, error } = await rpc("void_administration", { p_id: adm.id, p_reason: "Desfeito logo após o registro" });
      if (error) return toast(errText(error), true);
      upsertAdm(data); render(); toast("Desfeito. O estoque foi devolvido.");
    },
  });
}

/* ================= notificações ================= */
const b64u = (s) => { const p = "=".repeat((4 - (s.length % 4)) % 4); const r = atob((s + p).replace(/-/g, "+").replace(/_/g, "/")); return Uint8Array.from(r, (c) => c.charCodeAt(0)); };
async function refreshPushLabel() {
  const el = document.getElementById("pushLbl"); if (!el) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    el.textContent = Notification.permission === "denied" ? "bloqueado" : sub ? "lembretes ativados ✓" : "lembretes desativados";
    el.style.color = sub ? "var(--green)" : "var(--red)";
  } catch { el.textContent = "indisponível"; }
}
async function enablePush() {
  try {
    const perm = await Notification.requestPermission();
    if (perm !== "granted") { toast("Permissão negada. Libere as notificações nos ajustes do celular.", true); return render(); }
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64u(VAPID_PUBLIC) });
    const j = sub.toJSON();
    await sb.from("push_subscriptions").delete().eq("endpoint", j.endpoint);
    const { error } = await sb.from("push_subscriptions").insert({ family_id: S.family.id, user_id: S.me.user_id, endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth, user_agent: navigator.userAgent.slice(0, 200) });
    if (error && !String(error.message).includes("duplicate")) throw error;
    toast("Lembretes ativados neste celular. Faça o teste.");
  } catch (e) { toast("Não consegui ativar: " + (e.message || e), true); }
  refreshPushLabel();
}
async function disablePush() {
  try {
    const reg = await navigator.serviceWorker.ready; const sub = await reg.pushManager.getSubscription();
    if (sub) { await sb.from("push_subscriptions").delete().eq("endpoint", sub.endpoint); await sub.unsubscribe(); }
    toast("Lembretes desativados neste celular.");
  } catch (e) { toast(errText(e), true); }
  refreshPushLabel();
}
async function testPush() {
  try {
    const { data: { session } } = await sb.auth.getSession();
    const r = await fetch(`${SUPABASE_URL}/functions/v1/send-reminders`, { method: "POST", headers: { Authorization: `Bearer ${session.access_token}`, apikey: SUPABASE_KEY, "Content-Type": "application/json" }, body: "{}" });
    const j = await r.json();
    if (j.error === "sem_inscricao") return toast("Primeiro toque em “Ativar lembretes neste celular”.", true);
    if (!r.ok || !j.sent) return toast("O teste não chegou a ser enviado. Tente ativar de novo.", true);
    toast("Teste enviado. A notificação deve aparecer em alguns segundos.");
  } catch (e) { toast(errText(e), true); }
}
// Com o app aberto, também avisa localmente (mesma etiqueta do aviso do servidor, então não duplica).
function localReminders() {
  if (!S.family?.activated_at || !("Notification" in window) || Notification.permission !== "granted") return;
  const now = Date.now();
  let sent = {}; try { sent = JSON.parse(localStorage.getItem("avisosLocais") || "{}"); } catch {}
  const groups = new Map();
  for (const s of todaySlots()) {
    if (s.adm) continue;
    const d = s.at.getTime() - now;
    const kind = d <= 15 * 60e3 && d > 0 ? "antes" : d <= 0 && d > -20 * 60e3 ? "hora" : null;
    if (!kind) continue;
    const tag = `slot-${s.date}-${s.time.replace(":", "")}`;
    if (sent[tag + kind]) continue;
    if (!groups.has(tag + kind)) groups.set(tag + kind, { tag, kind, time: s.time, items: [] });
    groups.get(tag + kind).items.push(`${s.med.name} (${tabsOf(s.med, s.med.dose_qty)}${s.med.tablet_strength ? ", total " + s.med.strength : ""})`);
  }
  if (!groups.size) return;
  navigator.serviceWorker.ready.then((reg) => {
    for (const [k, g] of groups) {
      reg.showNotification(g.kind === "antes" ? `Em 15 minutos: remédios das ${g.time}` : `Hora dos remédios das ${g.time}`,
        { body: g.items.join(", ") + '. Depois de dar, toque em "Já administrei" no app.', tag: g.tag, renotify: true, icon: "icons/icon-192.png", badge: "icons/badge-96.png" });
      sent[k] = now;
    }
    for (const k in sent) if (now - sent[k] > 2 * 864e5) delete sent[k];
    try { localStorage.setItem("avisosLocais", JSON.stringify(sent)); } catch {}
  });
}
function updateBadge(n) {
  document.title = n ? `(${n}) Remédios Vó Marinho` : "Remédios Vó Marinho";
  try { if (navigator.setAppBadge) n ? navigator.setAppBadge(n) : navigator.clearAppBadge(); } catch {}
}

/* ================= cópia de segurança ================= */
async function exportCsv() {
  toast("Preparando a planilha…");
  try {
    const all = async (t, order) => { let out = [], from = 0; for (;;) { const r = await sb.from(t).select("*").order(order).range(from, from + 999); if (r.error) throw r.error; out = out.concat(r.data); if (r.data.length < 1000) return out; from += 1000; } };
    const [adm, stk] = await Promise.all([all("administrations", "given_at"), all("stock_movements", "created_at")]);
    const name = (id) => { const m = S.meds.find((x) => x.id === id); return m ? `${m.name} ${m.strength}` : id; };
    const cell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const fmt = (d) => d ? new Intl.DateTimeFormat("pt-BR", { timeZone: tz(), dateStyle: "short", timeStyle: "short" }).format(new Date(d)) : "";
    let csv = "﻿TIPO;DATA E HORA;REMÉDIO;QUANTIDADE;UNIDADE;HORÁRIO PREVISTO;QUEM;SITUAÇÃO;OBSERVAÇÃO\n";
    for (const a of adm) csv += ["Administração", fmt(a.given_at), name(a.medication_id), num(a.quantity), a.unit, a.slot_time ? `${a.slot_date} ${a.slot_time.slice(0, 5)}` : "se necessário", a.given_by_name,
      a.status === "anulado" ? `desfeito por ${a.voided_by_name} em ${fmt(a.voided_at)}` : "válido", a.void_reason || (a.replaces_id ? "correção" : "")].map(cell).join(";") + "\n";
    for (const s of stk) csv += ["Estoque: " + s.kind, fmt(s.created_at), name(s.medication_id), num(s.delta), "", "", s.created_by_name, "ficou " + num(s.stock_after), s.note || ""].map(cell).join(";") + "\n";
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `remedios-historico-${localDate()}.csv`; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    toast("Planilha baixada.");
  } catch (e) { toast(errText(e), true); }
}

/* ================= relógio ================= */
function stateSig() {
  if (!S.family?.activated_at) return "";
  const now = Date.now();
  return todaySlots().map((s) => s.key + slotState(s, now)).join(",") + localDate();
}
setInterval(() => {
  if (!S.session || S.loading || !S.family) return;
  if (stateSig() !== S.lastStateSig && !$sheet.classList.contains("open")) render();
  else document.querySelectorAll("[data-cd]").forEach((el) => (el.textContent = cdText(new Date(Number(el.dataset.cd)))));
  localReminders();
}, 20000);
setInterval(() => { if (S.session && document.visibilityState === "visible") reload(); }, 120000);

/* ================= eventos ================= */
document.addEventListener("click", (e) => {
  const el = e.target.closest("[data-act]"); if (!el) return;
  const fn = A[el.dataset.act]; if (!fn) return;
  e.preventDefault(); fn(el.dataset, el);
});
document.addEventListener("submit", async (e) => {
  if (e.target.id !== "login") return;
  e.preventDefault();
  const f = new FormData(e.target);
  const u = String(f.get("u")).trim().toLowerCase();
  const email = u.includes("@") ? u : `${u}@${LOGIN_DOMAIN}`;
  const btn = e.target.querySelector("button"); btn.disabled = true; btn.textContent = "Entrando…";
  const { error } = await sb.auth.signInWithPassword({ email, password: String(f.get("p")) });
  if (error) { btn.disabled = false; btn.textContent = "Entrar"; document.getElementById("loginErr").textContent = isNetwork(error) ? "Sem internet. Tente de novo." : "Usuário ou senha incorretos."; }
});
window.addEventListener("popstate", () => {
  if ($sheet.classList.contains("open")) return closeSheet(true);
  if (S.page) { S.page = null; render(); }
});
window.addEventListener("online", () => { S.online = true; renderStatus(); reload(); subscribe(); });
window.addEventListener("offline", () => { S.online = false; renderStatus(); });
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && S.session) { reload(); if (S.rt !== "ok") subscribe(); } });
window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); S.installEvt = e; if (S.tab === "config") render(); });

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});

sb.auth.onAuthStateChange((ev, session) => {
  const had = !!S.session; S.session = session;
  if (session && !had) { S.loading = true; render(); reload(); subscribe(); }
  if (!session && had) { S.me = null; S.family = null; render(); }
});
sb.auth.getSession().then(({ data }) => {
  S.session = data.session;
  if (!S.session) { S.loading = false; render(); }
});
