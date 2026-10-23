// Traducción gratuita con el navegador.
// Chrome de escritorio (138 o posterior) trae un traductor propio que funciona
// en el ordenador, sin enviar el texto a ningún sitio: la primera vez de cada
// idioma descarga el modelo. Donde no existe (Edge, Firefox, móvil…) se ofrece
// abrir el Traductor de Google en otra pestaña.

const TARGET = 'es';
export const builtInTranslator = typeof self !== 'undefined' && 'Translator' in self;

const baseLang = l => String(l || '').toLowerCase().replace('_', '-').split('-')[0];
const translators = new Map(); // «en>es» → Promise<Translator>
const cache = new Map();       // «en>es␁texto» → traducción

export const needsTranslation = lang => baseLang(lang) !== TARGET;

async function detect(text) {
  if (!('LanguageDetector' in self)) return null;
  try {
    const detector = await self.LanguageDetector.create();
    const [best] = await detector.detect(text);
    return best && best.confidence > 0.5 ? best.detectedLanguage : null;
  } catch { return null; }
}

async function translatorFor(source, onProgress) {
  const key = `${source}>${TARGET}`;
  if (!translators.has(key)) {
    const p = (async () => {
      const availability = await self.Translator.availability({ sourceLanguage: source, targetLanguage: TARGET });
      if (availability === 'unavailable') throw new Error('unavailable');
      return self.Translator.create({
        sourceLanguage: source,
        targetLanguage: TARGET,
        monitor(m) { m.addEventListener('downloadprogress', e => onProgress && onProgress(e.loaded)); },
      });
    })();
    translators.set(key, p);
    p.catch(() => translators.delete(key));
  }
  return translators.get(key);
}

export const SAME_LANGUAGE = 'same-language';

/**
 * Traduce al español con el traductor del navegador. Devuelve null si este
 * navegador no lo tiene o no sabe ese idioma (entonces, usar googleTranslateUrl),
 * y SAME_LANGUAGE si el texto ya está en español.
 */
export async function translate(texts, lang, onProgress) {
  if (!builtInTranslator) return null;
  let source = baseLang(lang);
  if (!source || source === '?') source = await detect(texts.join(' '));
  if (source === TARGET) return SAME_LANGUAGE;
  if (!source) return null;
  try {
    const tr = await translatorFor(source, onProgress);
    return await Promise.all(texts.map(async t => {
      const k = `${source}>${TARGET}\u0001${t}`;
      if (!cache.has(k)) cache.set(k, await tr.translate(t));
      return cache.get(k);
    }));
  } catch {
    return null;
  }
}

export function googleTranslateUrl(text, lang) {
  const sl = baseLang(lang);
  return `https://translate.google.com/?sl=${sl && sl !== '?' ? sl : 'auto'}&tl=${TARGET}&text=${encodeURIComponent(text)}&op=translate`;
}
