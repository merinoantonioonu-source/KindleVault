// Pronunciación con las voces del propio navegador (gratis y sin enviar nada
// fuera): en Edge son las mismas voces «naturales» de su «Leer en voz alta»;
// en Chrome, las de Google y las del sistema.

const synth = typeof window !== 'undefined' ? window.speechSynthesis : null;
export const speechSupported = !!synth && typeof SpeechSynthesisUtterance !== 'undefined';

let voicesPromise = null;
function voices() {
  if (!voicesPromise) {
    voicesPromise = new Promise(resolve => {
      const now = synth.getVoices();
      if (now.length) return resolve(now);
      synth.addEventListener('voiceschanged', () => resolve(synth.getVoices()), { once: true });
      setTimeout(() => resolve(synth.getVoices()), 1500);
    }).then(v => { if (!v.length) voicesPromise = null; return v; });
  }
  return voicesPromise;
}

const baseLang = l => String(l || '').toLowerCase().replace('_', '-').split('-')[0];

/** La mejor voz para un idioma: primero las naturales/en línea, luego las de Google. */
function pickVoice(list, lang) {
  const base = baseLang(lang);
  const full = String(lang || '').toLowerCase().replace('_', '-');
  const score = v => {
    const n = v.name.toLowerCase();
    let s = 0;
    if (/natural/.test(n)) s += 8;
    if (/online/.test(n)) s += 4;
    if (/google/.test(n)) s += 3;
    if (full.includes('-') && v.lang.toLowerCase().replace('_', '-') === full) s += 2;
    return s;
  };
  return list.filter(v => baseLang(v.lang) === base).sort((a, b) => score(b) - score(a))[0] || null;
}

/** Trozos de menos de ~180 caracteres: Chrome corta las frases largas a medias. */
function chunks(text) {
  const parts = String(text).replace(/\s+/g, ' ').trim().match(/[^.!?;:]+[.!?;:]*\s*/g) || [];
  const out = [];
  let cur = '';
  for (const p of parts) {
    if ((cur + p).length > 180 && cur) { out.push(cur.trim()); cur = ''; }
    cur += p;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/**
 * Lee el texto en voz alta en su idioma. Devuelve false si no hay ninguna voz
 * instalada para ese idioma (se lee igualmente con la voz por defecto).
 */
export async function speak(text, lang, { rate = 1 } = {}) {
  if (!speechSupported || !text) return false;
  synth.cancel();
  const list = await voices();
  const voice = lang && lang !== '?' ? pickVoice(list, lang) : null;
  for (const part of chunks(text)) {
    const u = new SpeechSynthesisUtterance(part);
    if (voice) { u.voice = voice; u.lang = voice.lang; } else if (lang && lang !== '?') u.lang = lang;
    u.rate = rate;
    synth.speak(u);
  }
  return !lang || lang === '?' || !!voice;
}

export function stopSpeaking() { if (speechSupported) synth.cancel(); }
