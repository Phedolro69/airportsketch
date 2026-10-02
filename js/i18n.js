// ========================================================
// LANGUE DU SITE (français par défaut, anglais)
// Le texte français sert de clé : t('Fréquences radio') renvoie la traduction de la langue courante, ou le
// français s'il n'y en a pas. Variables : t('{n} piste(s)', { n: 3 }). Textes du HTML : attributs data-i18n
// (contenu), data-i18n-title, data-i18n-placeholder, data-i18n-aria (aria-label) ; blocs entiers : [data-lang].
// Choix de la langue : ?lang=en|fr, sinon dernier choix mémorisé, sinon langue du navigateur.
// ========================================================
const LANG_KEY = 'pleinaxe.lang';
const LANG = (() => {
    const pick = v => (v === 'fr' || v === 'en') ? v : null;
    try {
        const url = new URL(location.href);
        const fromUrl = pick((url.searchParams.get('lang') || '').toLowerCase());
        if (fromUrl) {
            localStorage.setItem(LANG_KEY, fromUrl);
            url.searchParams.delete('lang');
            history.replaceState({}, '', url);
            return fromUrl;
        }
        const saved = pick(localStorage.getItem(LANG_KEY));
        if (saved) return saved;
    } catch (err) { /* stockage indisponible : langue du navigateur */ }
    const nav = (navigator.languages && navigator.languages[0]) || navigator.language || 'fr';
    return /^fr\b/i.test(nav) ? 'fr' : 'en';
})();
const LOCALE = LANG === 'en' ? 'en-GB' : 'fr-FR';
document.documentElement.lang = LANG;

function t(fr, vars) {
    let s = LANG === 'en' && Object.prototype.hasOwnProperty.call(I18N_EN, fr) ? I18N_EN[fr] : fr;
    if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
    return s;
}

// Change de langue : mémorisée, puis rechargement (tout le site est redessiné dans la nouvelle langue)
function setLang(lang) {
    try { localStorage.setItem(LANG_KEY, lang); } catch (err) { /* ignoré */ }
    const url = new URL(location.href);
    url.searchParams.set('lang', lang);
    location.href = url.href;
}

function applyI18n(root = document) {
    if (LANG === 'fr') return;
    root.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
    root.querySelectorAll('[data-i18n-html]').forEach(el => { el.innerHTML = t(el.dataset.i18nHtml); });
    root.querySelectorAll('[data-i18n-title]').forEach(el => { el.title = t(el.dataset.i18nTitle); });
    root.querySelectorAll('[data-i18n-placeholder]').forEach(el => { el.placeholder = t(el.dataset.i18nPlaceholder); });
    root.querySelectorAll('[data-i18n-aria]').forEach(el => { el.setAttribute('aria-label', t(el.dataset.i18nAria)); });
}

// Traductions anglaises, par texte français
const I18N_EN = {
};
