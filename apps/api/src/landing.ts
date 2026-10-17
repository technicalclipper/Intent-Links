/**
 * The landing page, served at the base URL.
 *
 * For someone who has heard of IntentLink but has neither the extension nor a
 * link yet: what it is in one sentence, how it works in three, and the
 * extension to download. Server-rendered and self-contained, like the consent
 * page, so it needs no build step and works before anything is installed.
 */

export const EXTENSION_ZIP_PATH = "/download/intentlink-extension.zip";
const REPO_URL = "https://github.com/technicalclipper/Intent-Links";

/**
 * `baseUrl` is wherever this service is actually reached, so the demo's
 * address bar shows the real host - localhost in development, the deployed
 * domain in production - with nothing to edit when that changes.
 */
export function landingPage(baseUrl: string): string {
  const host = baseUrl.replace(/^https?:\/\//, "").replace(/[&<>"']/g, "");
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>IntentLink — Send workflows as a shareable link</title>
<meta name="description" content="Do a task once in your browser. IntentLink turns it into a link. Whoever opens it gets the same task done by their own agent, inside the limits you set in plain English.">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:ital,wght@0,400;0,500;0,600;1,300;1,400&display=swap">
<style>
  :root{color-scheme:dark;
    --bg:#0b0d10;--surface:#12151a;--raised:#171b21;
    --line:rgba(226,230,238,.08);--line2:rgba(226,230,238,.15);
    --text:#e8eaee;--soft:#c3c8d1;--dim:#8a919e;--faint:#59606c;
    --allow:#2dd4a7;--approve:#f5b544;--deny:#ff5c6c;
    --mono:"IBM Plex Mono",ui-monospace,SFMono-Regular,Menlo,monospace;
    --sans:"IBM Plex Sans",-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;
    --ease:cubic-bezier(.16,1,.3,1)}
  *{box-sizing:border-box}
  html{background:var(--bg);scroll-behavior:smooth}
  body{margin:0;color:var(--text);font:16px/1.6 var(--sans);-webkit-font-smoothing:antialiased;overflow-x:hidden;
       background:radial-gradient(70% 45% at 70% -5%,rgba(232,234,238,.08),transparent 60%),var(--bg)}
  ::selection{background:rgba(232,234,238,.2)}
  a{color:inherit}
  .wrap{max-width:1160px;margin:0 auto;padding:0 24px}
  .grid-bg{position:absolute;inset:0;pointer-events:none;
    background-image:linear-gradient(rgba(255,255,255,.028) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.028) 1px,transparent 1px);
    background-size:56px 56px;
    -webkit-mask-image:radial-gradient(ellipse 70% 70% at 60% 20%,#000 10%,transparent 70%);
            mask-image:radial-gradient(ellipse 70% 70% at 60% 20%,#000 10%,transparent 70%)}

  /* ------------------------------------------------------------- nav */
  nav{position:sticky;top:0;z-index:20;border-bottom:1px solid transparent;transition:background .3s,border-color .3s}
  nav.scrolled{background:rgba(11,13,16,.78);backdrop-filter:blur(14px) saturate(1.2);border-bottom-color:var(--line)}
  .nav{display:flex;align-items:center;justify-content:space-between;height:68px}
  .brand{display:flex;align-items:center;gap:12px;font:600 17px/1 var(--sans);letter-spacing:-.01em;text-decoration:none}
  .links{display:flex;align-items:center;gap:28px;font-size:14px;color:var(--dim)}
  .links a{text-decoration:none;transition:color .15s}.links a:hover{color:var(--text)}
  @media (max-width:760px){.links .hide-sm{display:none}}

  .btn{display:inline-flex;align-items:center;gap:10px;font:600 15px/1 var(--sans);text-decoration:none;cursor:pointer;
       border-radius:12px;padding:15px 22px;border:1px solid var(--line2);background:var(--raised);color:var(--text);
       transition:background .15s,border-color .15s,transform .12s,box-shadow .2s}
  .btn:hover{border-color:rgba(226,230,238,.3)}
  .btn:active{transform:translateY(1px)}
  .btn.primary{background:var(--text);color:#0b0d10;border-color:transparent;
       box-shadow:0 0 0 1px rgba(255,255,255,.12) inset,0 14px 40px -14px rgba(232,234,238,.6)}
  .btn.primary:hover{background:#fff;box-shadow:0 0 0 1px rgba(255,255,255,.2) inset,0 18px 50px -12px rgba(232,234,238,.75)}
  .btn.small{padding:10px 15px;font-size:13.5px;border-radius:10px}
  .btn .arr{transition:transform .2s var(--ease)}.btn:hover .arr{transform:translateX(3px)}
  .btn .dl{transition:transform .2s var(--ease)}.btn:hover .dl{transform:translateY(2px)}
  .btn:focus-visible{outline:2px solid rgba(232,234,238,.6);outline-offset:3px}

  .eyebrow{display:inline-flex;align-items:center;gap:10px;font:500 12px/1 var(--mono);letter-spacing:.16em;text-transform:uppercase;color:var(--dim)}
  .pill{border:1px solid var(--line2);border-radius:999px;padding:8px 13px;background:rgba(255,255,255,.02)}
  .pill{white-space:nowrap}
  @media (max-width:420px){.pill{letter-spacing:.08em;font-size:11px}}
  .pill i{width:7px;height:7px;border-radius:50%;background:var(--allow);box-shadow:0 0 10px var(--allow);animation:beat 2s ease-in-out infinite}

  /* ------------------------------------------------------------ hero */
  .hero{position:relative;padding:72px 0 96px}
  .hero-grid{position:relative;display:grid;grid-template-columns:minmax(0,1.05fr) minmax(0,.95fr);gap:56px;align-items:center}
  @media (max-width:980px){.hero-grid{grid-template-columns:minmax(0,1fr);gap:48px}.hero{padding:40px 0 72px}}
  h1{margin:22px 0 22px;font:600 clamp(42px,6.4vw,76px)/1.02 var(--sans);letter-spacing:-.04em;text-wrap:balance}
  h1 .soft{color:var(--dim)}
  .lead{margin:0;max-width:540px;font-size:19px;line-height:1.55;color:var(--soft);text-wrap:pretty}
  .cta{display:flex;gap:12px;flex-wrap:wrap;margin-top:34px}
  .fine{margin-top:18px;font:400 12.5px/1.6 var(--mono);color:var(--faint)}
  .fine b{color:var(--dim);font-weight:500}

  /* The hero demo: a run that ticks three steps green and stops at the line. */
  .demo{position:relative;border-radius:18px;border:1px solid var(--line2);background:var(--surface);overflow:hidden;
        box-shadow:0 40px 100px -40px rgba(0,0,0,.9),0 0 0 1px rgba(0,0,0,.4),0 0 80px -40px rgba(232,234,238,.25)}
  .demo-top{display:flex;align-items:center;gap:14px;height:46px;padding:0 16px;border-bottom:1px solid var(--line);background:#15181e}
  .dots{display:flex;gap:7px}.dots i{width:10px;height:10px;border-radius:50%;background:#2c313a}
  .addr{flex:1;max-width:300px;margin:0 auto;height:26px;border-radius:13px;background:#0e1115;border:1px solid var(--line);
        font:400 12px/24px var(--mono);color:var(--soft);text-align:center;white-space:nowrap;overflow:hidden}
  .demo-body{padding:22px}
  .rules{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:20px}
  .chip{display:inline-flex;align-items:center;gap:10px;height:34px;padding:0 12px 0 6px;border-radius:8px;border:1px solid var(--line2);
        background:#0f1216;font:500 13px/1 var(--mono);color:var(--text)}
  .chip b{font:600 10px/1 var(--mono);letter-spacing:.14em;padding:5px 7px;border-radius:4px}
  .chip .a{background:var(--text);color:#0b0d10}
  .chip .d{border:1px solid var(--text)}
  .chip em{font-style:normal;color:var(--dim);font-weight:400}
  .runk{display:flex;justify-content:space-between;font:500 11px/1 var(--mono);letter-spacing:.16em;color:var(--dim);
        padding-bottom:12px;border-bottom:1px solid var(--line)}
  .runk span:last-child{letter-spacing:.04em;color:var(--faint)}
  .rows{list-style:none;margin:0;padding:0}
  .row{position:relative;display:grid;grid-template-columns:24px 1fr auto;gap:12px;align-items:center;padding:13px 0;border-bottom:1px solid var(--line);
       font:500 14px/1.3 var(--mono)}
  .row .n{width:24px;height:24px;border-radius:50%;display:grid;place-items:center;border:1px dashed rgba(232,234,238,.35);
          font-size:11px;color:#0b0d10;position:relative}
  .row .n::after{content:"";position:absolute;inset:-1px;border-radius:50%;background:var(--allow);
          box-shadow:0 0 0 4px rgba(45,212,167,.14),0 0 16px rgba(45,212,167,.5);transform:scale(0);opacity:0}
  .row .n svg{position:relative;z-index:1;opacity:0}
  .row .v{font:600 10.5px/1 var(--mono);letter-spacing:.14em;color:var(--allow);opacity:0}
  .row .w{color:var(--faint)}
  .row.no .n::after{background:var(--deny);box-shadow:0 0 0 4px rgba(255,92,108,.16),0 0 18px rgba(255,92,108,.6)}
  .row.no .v{color:var(--deny)}
  .q{display:block;margin-top:6px;font:italic 400 14px/1.3 var(--sans);color:var(--soft);opacity:0}
  .demo .bar{position:absolute;left:0;top:46px;bottom:0;width:3px;background:var(--deny);box-shadow:0 0 18px var(--deny);transform:scaleY(0);transform-origin:50% 72%}

  /* One 9s loop: three ticks, the reach, the line, a held beat. */
  .row:nth-child(1) .n::after,.row:nth-child(1) .n svg,.row:nth-child(1) .v{animation:on1 9s var(--ease) infinite}
  .row:nth-child(2) .n::after,.row:nth-child(2) .n svg,.row:nth-child(2) .v{animation:on2 9s var(--ease) infinite}
  .row:nth-child(3) .n::after,.row:nth-child(3) .n svg,.row:nth-child(3) .v{animation:on3 9s var(--ease) infinite}
  .row:nth-child(4) .n::after,.row:nth-child(4) .n svg,.row:nth-child(4) .v,.row:nth-child(4) .q{animation:on4 9s var(--ease) infinite}
  .row:nth-child(1) .w,.row:nth-child(2) .w,.row:nth-child(3) .w{animation:lit 9s linear infinite}
  .row .w4{color:var(--faint);animation:lit4 9s linear infinite}
  .demo .bar{animation:bar 9s var(--ease) infinite}
  @keyframes on1{0%,8%{opacity:0;transform:scale(0)}12%,92%{opacity:1;transform:scale(1)}97%,100%{opacity:0;transform:scale(1)}}
  @keyframes on2{0%,20%{opacity:0;transform:scale(0)}24%,92%{opacity:1;transform:scale(1)}97%,100%{opacity:0;transform:scale(1)}}
  @keyframes on3{0%,32%{opacity:0;transform:scale(0)}36%,92%{opacity:1;transform:scale(1)}97%,100%{opacity:0;transform:scale(1)}}
  @keyframes on4{0%,48%{opacity:0;transform:scale(0)}51%,92%{opacity:1;transform:scale(1)}97%,100%{opacity:0;transform:scale(1)}}
  @keyframes lit{0%,8%{color:var(--faint)}12%,92%{color:var(--text)}97%,100%{color:var(--faint)}}
  @keyframes lit4{0%,48%{color:var(--faint)}51%,92%{color:var(--text)}97%,100%{color:var(--faint)}}
  @keyframes bar{0%,47%{transform:scaleY(0)}50%,92%{transform:scaleY(1)}97%,100%{transform:scaleY(0)}}

  /* ---------------------------------------------------------- ticker */
  .ticker{position:relative;border-top:1px solid var(--line);border-bottom:1px solid var(--line);overflow:hidden;padding:18px 0;
          -webkit-mask-image:linear-gradient(90deg,transparent,#000 10%,#000 90%,transparent);mask-image:linear-gradient(90deg,transparent,#000 10%,#000 90%,transparent)}
  .track{display:flex;gap:44px;width:max-content;animation:slide 40s linear infinite;font:400 14px/1 var(--mono);color:var(--dim);white-space:nowrap}
  .track span::before{content:"";display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--faint);margin-right:14px;vertical-align:middle}
  .track span.g::before{background:var(--allow)}.track span.r::before{background:var(--deny)}
  @keyframes slide{to{transform:translateX(-50%)}}

  /* -------------------------------------------------------- sections */
  section{padding:110px 0}
  @media (max-width:760px){section{padding:80px 0}}
  .head{max-width:720px;margin-bottom:52px}
  h2{margin:16px 0 14px;font:600 clamp(32px,4.2vw,50px)/1.06 var(--sans);letter-spacing:-.035em;text-wrap:balance}
  .sub{margin:0;color:var(--soft);font-size:18px;max-width:620px;text-wrap:pretty}

  .card{position:relative;border-radius:18px;border:1px solid var(--line);
        background:linear-gradient(180deg,rgba(255,255,255,.03),rgba(255,255,255,0) 45%),var(--surface);
        box-shadow:0 1px 0 rgba(255,255,255,.03) inset,0 30px 60px -40px rgba(0,0,0,.9);
        transition:border-color .25s,transform .35s var(--ease),box-shadow .35s}
  .card:hover{border-color:var(--line2);transform:translateY(-3px)}

  .steps3{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}
  @media (max-width:900px){.steps3{grid-template-columns:minmax(0,1fr)}}
  .step{padding:26px}
  .step .k{font:500 12px/1 var(--mono);letter-spacing:.14em;color:var(--faint)}
  .step h3{margin:14px 0 8px;font:600 22px/1.2 var(--sans);letter-spacing:-.02em}
  .step p{margin:0;color:var(--dim);font-size:15px}
  .art{height:132px;margin:-4px -4px 22px;border-radius:12px;border:1px solid var(--line);background:#0e1115;position:relative;overflow:hidden;
       display:grid;place-items:center}

  /* Art 1: a cursor leaves a chain of nodes. */
  .chain{position:relative;width:200px;height:40px}
  .chain .ln{position:absolute;left:10px;right:10px;top:19px;height:1px;background:rgba(232,234,238,.25);transform-origin:0 50%;animation:draw 4s var(--ease) infinite}
  .chain .nd{position:absolute;top:13px;width:14px;height:14px;border-radius:50%;background:var(--text);box-shadow:0 0 14px rgba(232,234,238,.55);transform:scale(0);animation:pop 4s var(--ease) infinite}
  .chain .nd:nth-of-type(2){left:3px}.chain .nd:nth-of-type(3){left:93px;animation-delay:.5s}.chain .nd:nth-of-type(4){left:183px;animation-delay:1s}
  @keyframes draw{0%{transform:scaleX(0);opacity:1}35%,85%{transform:scaleX(1);opacity:1}100%{transform:scaleX(1);opacity:0}}
  @keyframes pop{0%,5%{transform:scale(0);opacity:1}12%,85%{transform:scale(1);opacity:1}100%{transform:scale(1);opacity:0}}

  /* Art 2: a sentence becomes rules. */
  .say{display:grid;gap:9px;justify-items:start;font-size:13px}
  .say .s{font:italic 300 15px/1 var(--sans);color:var(--soft);animation:fadeS 5s ease-in-out infinite}
  .say .chip{height:28px;font-size:12px;opacity:0;transform:translateY(6px);animation:chipIn 5s var(--ease) infinite}
  .say .chip:nth-child(3){animation-delay:.15s}
  @keyframes fadeS{0%,30%{opacity:1}45%,90%{opacity:.3}100%{opacity:1}}
  @keyframes chipIn{0%,30%{opacity:0;transform:translateY(6px)}42%,90%{opacity:1;transform:none}100%{opacity:0}}

  /* Art 3: a link flies to another screen. */
  .send{position:relative;width:230px;height:70px}
  .send .scr{position:absolute;top:10px;width:64px;height:50px;border-radius:8px;border:1px solid var(--line2);background:#14171d}
  .send .scr.a{left:0}.send .scr.b{right:0;border-color:rgba(232,234,238,.3)}
  .send .scr::after{content:"";position:absolute;left:8px;right:8px;top:8px;height:6px;border-radius:3px;background:var(--line2)}
  .send .cap{position:absolute;top:28px;left:60px;width:56px;height:14px;border-radius:7px;border:1px solid var(--text);background:#0e1115;
             box-shadow:0 0 14px rgba(232,234,238,.4);animation:fly 3.2s var(--ease) infinite}
  @keyframes fly{0%,15%{transform:translateX(0);opacity:0}25%{opacity:1}65%{transform:translateX(58px);opacity:1}80%,100%{transform:translateX(58px);opacity:0}}
  .send .ok{position:absolute;right:22px;top:24px;width:20px;height:20px;border-radius:50%;background:var(--allow);display:grid;place-items:center;
            box-shadow:0 0 14px rgba(45,212,167,.6);transform:scale(0);animation:okp 3.2s var(--ease) infinite}
  @keyframes okp{0%,62%{transform:scale(0);opacity:1}72%,90%{transform:scale(1);opacity:1}100%{transform:scale(1);opacity:0}}

  /* ------------------------------------------------- the grant section */
  .grant{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:56px;align-items:center}
  @media (max-width:900px){.grant{grid-template-columns:minmax(0,1fr);gap:36px}}
  .grant-art{padding:30px}
  .sent{font:italic 300 clamp(20px,2.3vw,26px)/1.35 var(--sans);color:var(--text);padding:20px 22px;border-radius:12px;border:1px solid var(--line2);background:#0e1115}
  .sent u{text-decoration:none;border-bottom:1px solid rgba(232,234,238,.5);padding-bottom:1px}
  .down{display:flex;align-items:center;gap:10px;margin:18px 0;font:500 11px/1 var(--mono);letter-spacing:.16em;color:var(--dim)}
  .down::before,.down::after{content:"";flex:1;height:1px;background:var(--line)}
  .compiled{display:grid;gap:10px}
  .compiled .chip{height:48px;font-size:17px;padding-right:18px}
  .compiled .chip b{font-size:11px;padding:6px 9px}
  .pts{list-style:none;margin:30px 0 0;padding:0;display:grid;gap:16px}
  .pts li{display:grid;grid-template-columns:28px 1fr;gap:12px;color:var(--soft);font-size:16px}
  .pts .ic{width:28px;height:28px;border-radius:8px;border:1px solid var(--line2);display:grid;place-items:center;background:var(--raised)}
  .pts b{color:var(--text);font-weight:500}

  /* ------------------------------------------------------ use cases */
  .uses{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}
  @media (max-width:980px){.uses{grid-template-columns:repeat(2,minmax(0,1fr))}}
  @media (max-width:640px){.uses{grid-template-columns:minmax(0,1fr)}}
  .use{padding:24px;display:flex;flex-direction:column}
  .use .tag{font:500 11px/1 var(--mono);letter-spacing:.14em;text-transform:uppercase;color:var(--faint)}
  .use h3{margin:12px 0 8px;font:600 19px/1.25 var(--sans);letter-spacing:-.015em}
  .use p{margin:0 0 20px;color:var(--dim);font-size:15px;flex:1}
  .use .chip{align-self:flex-start;height:30px;font-size:12px;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .use:hover .chip{border-color:rgba(232,234,238,.3)}

  /* ---------------------------------------------------------- trust */
  .trust{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}
  @media (max-width:900px){.trust{grid-template-columns:minmax(0,1fr)}}
  .t{padding:26px}
  .t .ic{width:42px;height:42px;border-radius:12px;display:grid;place-items:center;border:1px solid var(--line2);background:var(--raised);margin-bottom:18px}
  .t h3{margin:0 0 8px;font:600 18px/1.3 var(--sans);letter-spacing:-.015em}
  .t p{margin:0;color:var(--dim);font-size:15px}

  /* -------------------------------------------------------- install */
  .install{display:grid;grid-template-columns:minmax(0,.9fr) minmax(0,1.1fr);gap:48px;align-items:start;padding:40px}
  @media (max-width:900px){.install{grid-template-columns:minmax(0,1fr);padding:28px;gap:32px}}
  .install h2{font-size:clamp(28px,3.4vw,40px)}
  .how{list-style:none;margin:0;padding:0;display:grid;gap:12px;counter-reset:s}
  .how li{position:relative;display:grid;grid-template-columns:36px 1fr;gap:14px;padding:16px;border-radius:12px;border:1px solid var(--line);background:#0e1115}
  .how li::before{counter-increment:s;content:counter(s,decimal-leading-zero);width:36px;height:36px;border-radius:50%;display:grid;place-items:center;
                  border:1px solid var(--line2);font:500 12px/1 var(--mono);color:var(--text)}
  .how b{font-weight:500}
  .how p{margin:4px 0 0;color:var(--dim);font-size:14.5px}
  .code{display:inline-flex;align-items:center;gap:8px;margin-top:8px;padding:6px 6px 6px 10px;border-radius:8px;border:1px solid var(--line2);
        background:var(--raised);font:500 13px/1 var(--mono);color:var(--text)}
  .code button{all:unset;cursor:pointer;font:500 11px/1 var(--sans);color:var(--dim);padding:6px 8px;border-radius:6px;border:1px solid var(--line)}
  .code button:hover{color:var(--text);border-color:var(--line2)}

  /* ----------------------------------------------------- final + foot */
  .final{text-align:center;padding:120px 0 110px;position:relative}
  .final h2{font-size:clamp(38px,5.6vw,68px);margin:18px auto 16px;max-width:900px}
  .final .sub{margin:0 auto}
  .final .cta{justify-content:center}
  .mark{display:flex;justify-content:center}
  footer{border-top:1px solid var(--line);padding:30px 0 40px;color:var(--faint);font-size:13.5px}
  .foot{display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap}
  .foot a{text-decoration:none;color:var(--dim)}.foot a:hover{color:var(--text)}

  /* ---------------------------------------------------------- motion */
  .rv{opacity:0;transform:translateY(18px);transition:opacity .8s var(--ease),transform .8s var(--ease)}
  .rv.in{opacity:1;transform:none}
  .d1{transition-delay:.08s}.d2{transition-delay:.16s}.d3{transition-delay:.24s}.d4{transition-delay:.32s}
  @keyframes beat{0%,100%{opacity:1}50%{opacity:.4}}
  @media (prefers-reduced-motion:reduce){
    *,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important}
    .rv{opacity:1;transform:none}
    .row .n::after,.row .n svg,.row .v,.q,.say .chip,.chain .nd,.send .ok{opacity:1!important;transform:none!important}
    .demo .bar,.chain .ln{transform:none!important}
  }
</style></head>
<body>

<nav id="nav"><div class="wrap nav">
  <a class="brand" href="#top" aria-label="IntentLink home">
    <svg width="46" height="14" viewBox="0 0 46 14" aria-hidden="true"><line x1="4" y1="7" x2="30" y2="7" stroke="#e8eaee" stroke-opacity=".45" stroke-width="1.3"/><circle cx="4" cy="7" r="3" fill="#e8eaee"/><circle cx="17" cy="7" r="3" fill="#e8eaee"/><circle cx="30" cy="7" r="3" fill="#e8eaee"/><rect x="39" y=".5" width="2.4" height="13" rx="1.2" fill="#ff5c6c"/></svg>
    IntentLink
  </a>
  <div class="links">
    <a class="hide-sm" href="#how">How it works</a>
    <a class="hide-sm" href="#uses">Use cases</a>
    <a class="hide-sm" href="#install">Install</a>
    <a class="btn small primary" href="${EXTENSION_ZIP_PATH}" download>Download</a>
  </div>
</div></nav>

<header class="hero" id="top">
  <div class="grid-bg"></div>
  <div class="wrap hero-grid">
    <div>
      <span class="eyebrow pill rv"><i></i>Send workflows as a shareable link</span>
      <h1 class="rv d1">Don’t send instructions. <span class="soft">Send the intent.</span></h1>
      <p class="lead rv d2">Do a task once in your browser. IntentLink turns it into a link. Whoever opens it gets the same task done by their own agent, inside the limits you set in plain English.</p>
      <div class="cta rv d3">
        <a class="btn primary" href="${EXTENSION_ZIP_PATH}" download>
          <svg class="dl" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2v8.5M4.5 7L8 10.5 11.5 7M3 13.5h10" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>
          Download for Chrome
        </a>
        <a class="btn" href="#how">See how it works <span class="arr" aria-hidden="true">→</span></a>
      </div>
      <p class="fine rv d4"><b>Free</b> · Works in any web app · Your rules are enforced outside the model</p>
    </div>

    <div class="demo rv d2" aria-label="An IntentLink run: three steps allowed, the fourth blocked by the creator's rule">
      <div class="bar"></div>
      <div class="demo-top"><div class="dots"><i></i><i></i><i></i></div><div class="addr">${host}/i/7x92kq</div></div>
      <div class="demo-body">
        <div class="rules">
          <span class="chip"><b class="a">ALLOW</b>set_theme <em>"light"</em></span>
          <span class="chip"><b class="d">DENY</b>delete_*</span>
        </div>
        <div class="runk"><span>THEIR AGENT · RUN</span><span>policy 3f9a…c21</span></div>
        <ol class="rows">
          <li class="row"><span class="n"><svg width="11" height="11" viewBox="0 0 12 12"><path d="M2.2 6.3l2.4 2.4L9.8 3.5" fill="none" stroke="#0b0d10" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></span><span class="w">open_menu</span><span class="v">ALLOW</span></li>
          <li class="row"><span class="n"><svg width="11" height="11" viewBox="0 0 12 12"><path d="M2.2 6.3l2.4 2.4L9.8 3.5" fill="none" stroke="#0b0d10" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></span><span class="w">open_appearance</span><span class="v">ALLOW</span></li>
          <li class="row"><span class="n"><svg width="11" height="11" viewBox="0 0 12 12"><path d="M2.2 6.3l2.4 2.4L9.8 3.5" fill="none" stroke="#0b0d10" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></span><span class="w">set_theme</span><span class="v">ALLOW</span></li>
          <li class="row no"><span class="n"><svg width="11" height="11" viewBox="0 0 12 12"><path d="M3 3l6 6M9 3l-6 6" fill="none" stroke="#0b0d10" stroke-width="2" stroke-linecap="round"/></svg></span><span class="w4">delete_history<span class="q">“don’t delete anything”</span></span><span class="v">BLOCKED</span></li>
        </ol>
      </div>
    </div>
  </div>
</header>

<div class="ticker" aria-hidden="true"><div class="track">
  <span class="g">set_theme</span><span class="g">add_recipient</span><span class="g">create_channel</span><span class="r">delete_*</span><span class="g">set_topic</span><span class="g">invite_member</span><span class="g">export_report</span><span class="r">send_outside_company</span><span class="g">set_priority</span><span class="g">fill_subject</span><span class="r">purchase_*</span><span class="g">assign_owner</span>
  <span class="g">set_theme</span><span class="g">add_recipient</span><span class="g">create_channel</span><span class="r">delete_*</span><span class="g">set_topic</span><span class="g">invite_member</span><span class="g">export_report</span><span class="r">send_outside_company</span><span class="g">set_priority</span><span class="g">fill_subject</span><span class="r">purchase_*</span><span class="g">assign_owner</span>
</div></div>

<section id="how"><div class="wrap">
  <div class="head rv">
    <span class="eyebrow">How it works</span>
    <h2>Show it once. Share it as a link.</h2>
    <p class="sub">No scripts, no step-by-step docs that go stale. You do the task the normal way, and the link carries what you meant.</p>
  </div>
  <div class="steps3">
    <div class="card step rv">
      <div class="art"><div class="chain"><span class="ln"></span><span class="nd"></span><span class="nd"></span><span class="nd"></span></div></div>
      <div class="k">01 · RECORD</div>
      <h3>Do the task once</h3>
      <p>Click through it in any web app. Each click is captured by what it is, a button called “Compose”, never by where it was on the screen.</p>
    </div>
    <div class="card step rv d1">
      <div class="art"><div class="say"><span class="s">“don’t delete anything”</span><span class="chip"><b class="a">ALLOW</b>set_theme</span><span class="chip"><b class="d">DENY</b>delete_*</span></div></div>
      <div class="k">02 · BOUND</div>
      <h3>Say what it must never do</h3>
      <p>Type your limits in plain English. Gemini turns the sentence into rules, and a policy engine enforces them on every action.</p>
    </div>
    <div class="card step rv d2">
      <div class="art"><div class="send"><span class="scr a"></span><span class="cap"></span><span class="scr b"></span><span class="ok"><svg width="10" height="10" viewBox="0 0 12 12"><path d="M2.2 6.3l2.4 2.4L9.8 3.5" fill="none" stroke="#0b0d10" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg></span></div></div>
      <div class="k">03 · SHARE</div>
      <h3>Send the link</h3>
      <p>They open it, read what it will do, and press Run. Their agent does the task in their own browser, signed in as them.</p>
    </div>
  </div>
</div></section>

<section style="padding-top:20px"><div class="wrap grant">
  <div class="rv">
    <span class="eyebrow">The idea</span>
    <h2>The recording is the grant. English is the restriction.</h2>
    <p class="sub">What you showed is what it may do. What you wrote is where it stops, quoted back in your own words the moment anything reaches for the line.</p>
    <ul class="pts">
      <li><span class="ic"><svg width="14" height="14" viewBox="0 0 14 14"><path d="M2.5 7.3l2.8 2.8L11.5 3.8" fill="none" stroke="#2dd4a7" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></span><span><b>Deny by default.</b> Anything you didn’t show and didn’t allow is refused.</span></li>
      <li><span class="ic"><svg width="14" height="14" viewBox="0 0 14 14"><circle cx="7" cy="7" r="5" fill="none" stroke="#f5b544" stroke-width="1.6"/><path d="M7 4.5V7l1.6 1.3" fill="none" stroke="#f5b544" stroke-width="1.6" stroke-linecap="round"/></svg></span><span><b>Ask first, when you say so.</b> “Ask me before paging anyone” pauses for a person.</span></li>
      <li><span class="ic"><svg width="14" height="14" viewBox="0 0 14 14"><line x1="9" y1="2" x2="9" y2="12" stroke="#ff5c6c" stroke-width="2" stroke-linecap="round"/><path d="M2.5 7h4" stroke="#8a919e" stroke-width="1.6" stroke-linecap="round"/></svg></span><span><b>The model can’t talk its way past.</b> Rules are checked by code, outside the AI, before every action.</span></li>
    </ul>
  </div>
  <div class="card grant-art rv d1">
    <div class="sent">only <u>change the theme</u> — don’t <u>delete</u> anything</div>
    <div class="down">COMPILED BY GEMINI</div>
    <div class="compiled">
      <span class="chip"><b class="a">ALLOW</b>set_theme <em>theme = "light"</em></span>
      <span class="chip"><b class="d">DENY</b>delete_* <em>any target</em></span>
    </div>
  </div>
</div></section>

<section id="uses" style="padding-top:40px"><div class="wrap">
  <div class="head rv">
    <span class="eyebrow">Use cases</span>
    <h2>Send workflows as a shareable link.</h2>
    <p class="sub">Anything you’d otherwise explain in a doc, a call or twenty screenshots.</p>
  </div>
  <div class="uses">
    <div class="card use rv"><span class="tag">Teams</span><h3>Onboard a new teammate</h3><p>Set up their channels, groups and settings the way yours are, in their own accounts.</p><span class="chip"><b class="d">DENY</b>invite_outside_company</span></div>
    <div class="card use rv d1"><span class="tag">Support</span><h3>Hand off a fix</h3><p>Show the fix once. Customers or colleagues run the same steps without a screen share.</p><span class="chip"><b class="d">DENY</b>delete_*</span></div>
    <div class="card use rv d2"><span class="tag">Email</span><h3>Send a standard message</h3><p>Compose, address and send the same email, with the recipient changeable by whoever runs it.</p><span class="chip"><b class="a">ALLOW</b>send_email <em>to = you choose</em></span></div>
    <div class="card use rv"><span class="tag">Ops</span><h3>Repeat a monthly chore</h3><p>Export the report, file it, ping the channel. Record it once and share it with the rota.</p><span class="chip"><b class="a">ALLOW</b>export_report</span></div>
    <div class="card use rv d1"><span class="tag">IT</span><h3>Change a setting for everyone</h3><p>One link fixes the same setting across a team, and can’t touch anything else on the way.</p><span class="chip"><b class="a">ALLOW</b>set_theme <em>"light"</em></span></div>
    <div class="card use rv d2"><span class="tag">Family</span><h3>Help someone with an app</h3><p>Do it on your account; they tap the link and it happens on theirs. Nothing gets bought.</p><span class="chip"><b class="d">DENY</b>purchase_*</span></div>
  </div>
</div></section>

<section style="padding-top:40px"><div class="wrap">
  <div class="head rv">
    <span class="eyebrow">Safe by construction</span>
    <h2>Their browser. Their accounts. Your rules.</h2>
  </div>
  <div class="trust">
    <div class="card t rv"><div class="ic"><svg width="20" height="20" viewBox="0 0 20 20"><rect x="3" y="4" width="14" height="12" rx="2.2" fill="none" stroke="#c3c8d1" stroke-width="1.4"/><line x1="3" y1="7.5" x2="17" y2="7.5" stroke="#c3c8d1" stroke-width="1.4"/></svg></div><h3>Runs where they are signed in</h3><p>The task happens in the receiver’s own browser with their own sessions. No passwords are shared and the creator never sees them.</p></div>
    <div class="card t rv d1"><div class="ic"><svg width="20" height="20" viewBox="0 0 20 20"><path d="M10 2.8l6 2.2v4.6c0 3.6-2.5 6.1-6 7.4-3.5-1.3-6-3.8-6-7.4V5z" fill="none" stroke="#c3c8d1" stroke-width="1.4" stroke-linejoin="round"/><path d="M7.4 10l1.9 1.9 3.4-3.7" fill="none" stroke="#2dd4a7" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></div><h3>Checked before every action</h3><p>Each click needs a single-use token from the policy engine, bound to that exact step and element. No token, no action.</p></div>
    <div class="card t rv d2"><div class="ic"><svg width="20" height="20" viewBox="0 0 20 20"><rect x="4" y="3" width="12" height="14" rx="2" fill="none" stroke="#c3c8d1" stroke-width="1.4"/><path d="M7 7h6M7 10h6M7 13h3.5" stroke="#c3c8d1" stroke-width="1.4" stroke-linecap="round"/></svg></div><h3>Every step on the record</h3><p>Allowed, paused and blocked actions are written to a hash-chained audit log, so the history can be verified end to end.</p></div>
  </div>
</div></section>

<section id="install" style="padding-top:40px"><div class="wrap">
  <div class="card install rv">
    <div>
      <span class="eyebrow">Install</span>
      <h2>Up and running in a minute.</h2>
      <p class="sub" style="font-size:16px">Add the extension to Chrome, then press Record in its side panel to make your first link.</p>
      <div class="cta">
        <a class="btn primary" href="${EXTENSION_ZIP_PATH}" download>
          <svg class="dl" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2v8.5M4.5 7L8 10.5 11.5 7M3 13.5h10" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>
          Download the extension
        </a>
      </div>
    </div>
    <ol class="how">
      <li><span><b>Download and unzip</b><p>You’ll get a folder called <span style="font-family:var(--mono);color:var(--text)">intentlink-extension</span>.</p></span></li>
      <li><span><b>Open Chrome’s extensions page</b><p>Paste this into the address bar, then turn on <b>Developer mode</b> at the top right.</p><span class="code">chrome://extensions<button type="button" id="copy">Copy</button></span></span></li>
      <li><span><b>Load it</b><p>Click <b>Load unpacked</b> and choose the <span style="font-family:var(--mono);color:var(--text)">intentlink-extension</span> folder. Pin it from the puzzle-piece menu.</p></span></li>
      <li><span><b>Make your first link</b><p>Click the IntentLink icon to open the side panel, press <b>Record</b>, and do a task once.</p></span></li>
    </ol>
  </div>
</div></section>

<div class="final"><div class="wrap">
  <div class="mark rv"><svg width="92" height="26" viewBox="0 0 92 26" aria-hidden="true"><line x1="7" y1="13" x2="59" y2="13" stroke="#e8eaee" stroke-opacity=".45" stroke-width="2"/><circle cx="7" cy="13" r="5.5" fill="#e8eaee"/><circle cx="33" cy="13" r="5.5" fill="#e8eaee"/><circle cx="59" cy="13" r="5.5" fill="#e8eaee"/><rect x="78" y="1" width="4" height="24" rx="2" fill="#ff5c6c"/></svg></div>
  <h2 class="rv d1">Don’t send instructions. Send the intent.</h2>
  <p class="sub rv d2">Record it once. Share the link. Know it can’t go past the line you drew.</p>
  <div class="cta rv d3">
    <a class="btn primary" href="${EXTENSION_ZIP_PATH}" download>Download for Chrome</a>
    <a class="btn" href="${REPO_URL}" target="_blank" rel="noreferrer">View on GitHub <span class="arr" aria-hidden="true">→</span></a>
  </div>
</div></div>

<footer><div class="wrap foot">
  <span>IntentLink · Built with Gemini and Google ADK</span>
  <span><a href="${REPO_URL}" target="_blank" rel="noreferrer">GitHub</a></span>
</div></footer>

<script>
  (function () {
    var nav = document.getElementById("nav");
    var onScroll = function () { nav.classList.toggle("scrolled", window.scrollY > 8); };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });

    var items = document.querySelectorAll(".rv");
    if (!("IntersectionObserver" in window)) {
      items.forEach(function (el) { el.classList.add("in"); });
    } else {
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (e) {
          if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); }
        });
      }, { rootMargin: "0px 0px -8% 0px", threshold: 0.12 });
      items.forEach(function (el) { io.observe(el); });
    }

    var copy = document.getElementById("copy");
    copy.addEventListener("click", function () {
      var done = function () { copy.textContent = "Copied"; setTimeout(function () { copy.textContent = "Copy"; }, 1400); };
      if (navigator.clipboard) navigator.clipboard.writeText("chrome://extensions").then(done, done);
    });
  })();
</script>
</body></html>`;
}
