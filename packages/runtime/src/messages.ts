export type MessageFunction = (param?: object) => string | any[];
export interface MessageData {
  [key: string]: MessageData | MessageFunction | string;
}

/**
 * Accessor class for compiled message functions generated by
 * [messageformat](https://www.npmjs.com/package/messageformat)
 *
 * ```js
 * import Messages from 'messageformat-runtime/messages'
 * ```
 *
 * @example
 * ```js
 * // build.js
 * import fs from 'fs';
 * import MessageFormat from 'messageformat';
 *
 * const mf = new MessageFormat(['en', 'fi']);
 * const msgSet = {
 *   en: {
 *     a: 'A {TYPE} example.',
 *     b: 'This has {COUNT, plural, one{one user} other{# users}}.',
 *     c: {
 *       d: 'We have {P, number, percent} code coverage.'
 *     }
 *   },
 *   fi: {
 *     b: 'Tällä on {COUNT, plural, one{yksi käyttäjä} other{# käyttäjää}}.',
 *     e: 'Minä puhun vain suomea.'
 *   }
 * };
 * fs.writeFileSync('messages.js', String(mf.compile(msgSet)));
 * ```
 *
 * ```js
 * // runtime.js
 * import Messages from 'messageformat-runtime/messages';
 * import msgData from './messages';
 *
 * const messages = new Messages(msgData, 'en');
 *
 * messages.hasMessage('a')                // true
 * messages.hasObject('c')                 // true
 * messages.get('b', { COUNT: 3 })         // 'This has 3 users.'
 * messages.get(['c', 'd'], { P: 0.314 })  // 'We have 31% code coverage.'
 *
 * messages.get('e')                       // 'e'
 * messages.setFallback('en', ['foo', 'fi'])
 * messages.get('e')                       // 'Minä puhun vain suomea.'
 *
 * messages.locale = 'fi'
 * messages.hasMessage('a')                // false
 * messages.hasMessage('a', 'en')          // true
 * messages.hasMessage('a', null, true)    // true
 * messages.hasObject('c')                 // false
 * messages.get('b', { COUNT: 3 })         // 'Tällä on 3 käyttäjää.'
 * messages.get('c').d({ P: 0.628 })       // 'We have 63% code coverage.'
 * ```
 */
export default class Messages {
  _data: { [key: string]: MessageData } = {};
  _fallback: { [key: string]: string[] | null } = {};
  _defaultLocale: string | null = null;
  _locale: string | null = null;

  /**
   * @param msgData A map of locale codes to their function objects
   * @param defaultLocale If not defined, default and initial locale is the
   *   first key of `msgData`
   */
  constructor(msgData: { [key: string]: MessageData }, defaultLocale?: string) {
    Object.keys(msgData).forEach(lc => {
      if (lc !== 'toString') {
        this._data[lc] = msgData[lc];
        if (defaultLocale === undefined) defaultLocale = lc;
      }
    });
    this.locale = defaultLocale || null;
    this._defaultLocale = this.locale;
  }

  /**
   * List of available locales
   * @readonly
   */
  get availableLocales(): string[] {
    return Object.keys(this._data);
  }

  /**
   * Current locale
   *
   * One of {@link Messages.availableLocales} or `null`. Partial matches of
   * language tags are supported, so e.g. with an `en` locale defined, it will
   * be selected by `messages.locale = 'en-US'` and vice versa.
   */
  get locale(): string | null {
    return this._locale;
  }
  set locale(locale) {
    this._locale = this.resolveLocale(locale);
  }

  /**
   * Default fallback locale
   *
   * One of {@link Messages.availableLocales} or `null`. Partial matches of
   * language tags are supported, so e.g. with an `en` locale defined, it will
   * be selected by `messages.defaultLocale = 'en-US'` and vice versa.
   */
  get defaultLocale(): string | null {
    return this._defaultLocale;
  }
  set defaultLocale(locale: string | null) {
    this._defaultLocale = this.resolveLocale(locale);
  }

  /**
   * Add new messages to the accessor; useful if loading data dynamically
   *
   * The locale code `lc` should be an exact match for the locale being updated,
   * or empty to default to the current locale. Use
   * {@link Messages.resolveLocale} for resolving partial locale strings.
   *
   * If `keypath` is empty, adds or sets the complete message object for the
   * corresponding locale. If any keys in `keypath` do not exist, a new object
   * will be created at that key.
   *
   * @param data Hierarchical map of keys to functions, or a single message
   *   function
   * @param locale If empty or undefined, defaults to `this.locale`
   * @param keypath The keypath being added
   */
  addMessages(
    data: MessageData | MessageFunction,
    locale?: string,
    keypath?: string[]
  ) {
    const lc = locale || String(this.locale);
    if (typeof data !== 'function') {
      data = Object.keys(data).reduce<MessageData>((map, key) => {
        if (key !== 'toString') map[key] = (data as MessageData)[key];
        return map;
      }, {});
    }
    if (Array.isArray(keypath) && keypath.length > 0) {
      let parent = this._data[lc] as MessageData;
      for (let i = 0; i < keypath.length - 1; ++i) {
        const key = keypath[i];
        if (!parent[key]) parent[key] = {};
        parent = parent[key] as MessageData;
      }
      parent[keypath[keypath.length - 1]] = data;
    } else {
      this._data[lc] = data as MessageData;
    }
    return this;
  }

  /**
   * Resolve `lc` to the key of an available locale or `null`, allowing for
   * partial matches. For example, with an `en` locale defined, it will be
   * selected by `messages.defaultLocale = 'en-US'` and vice versa.
   */
  resolveLocale(locale: string | null) {
    let lc = String(locale);
    if (this._data[lc]) return locale;
    if (locale) {
      while ((lc = lc.replace(/[-_]?[^-_]*$/, ''))) {
        if (this._data[lc]) return lc;
      }
      const ll = this.availableLocales;
      const re = new RegExp('^' + locale + '[-_]');
      for (let i = 0; i < ll.length; ++i) {
        if (re.test(ll[i])) return ll[i];
      }
    }
    return null;
  }

  /**
   * Get the list of fallback locales
   * @param locale If empty or undefined, defaults to `this.locale`
   */
  getFallback(locale?: string | null) {
    const lc = locale || String(this.locale);
    return (
      this._fallback[lc] ||
      (lc === this.defaultLocale || !this.defaultLocale
        ? []
        : [this.defaultLocale])
    );
  }

  /**
   * Set the fallback locale or locales for `lc`
   *
   * To disable fallback for the locale, use `setFallback(lc, [])`.
   * To use the default fallback, use `setFallback(lc, null)`.
   */
  setFallback(lc: string, fallback: string[] | null) {
    this._fallback[lc] = Array.isArray(fallback) ? fallback : null;
    return this;
  }

  /**
   * Check if `key` is a message function for the locale
   *
   * `key` may be a `string` for functions at the root level, or `string[]` for
   * accessing hierarchical objects. If an exact match is not found and
   * `fallback` is true, the fallback locales are checked for the first match.
   *
   * @param key The key or keypath being sought
   * @param locale If empty or undefined, defaults to `this.locale`
   * @param fallback If true, also checks fallback locales
   */
  hasMessage(key: string | string[], locale?: string, fallback?: boolean) {
    const lc = locale || String(this.locale);
    const fb = fallback ? this.getFallback(lc) : null;
    return _has(this._data, lc, key, fb, 'function');
  }

  /**
   * Check if `key` is a message object for the locale
   *
   * `key` may be a `string` for functions at the root level, or `string[]` for
   * accessing hierarchical objects. If an exact match is not found and
   * `fallback` is true, the fallback locales are checked for the first match.
   *
   * @param key The key or keypath being sought
   * @param locale If empty or undefined, defaults to `this.locale`
   * @param fallback If true, also checks fallback locales
   */
  hasObject(key: string | string[], locale?: string, fallback?: boolean) {
    const lc = locale || String(this.locale);
    const fb = fallback ? this.getFallback(lc) : null;
    return _has(this._data, lc, key, fb, 'object');
  }

  /**
   * Get the message or object corresponding to `key`
   *
   * `key` may be a `string` for functions at the root level, or `string[]` for
   * accessing hierarchical objects. If an exact match is not found, the
   * fallback locales are checked for the first match.
   *
   * @param key The key or keypath being sought
   * @param props Optional properties passed to the function
   * @param lc If empty or undefined, defaults to `this.locale`
   * @returns If `key` maps to a message function, the returned value will be
   *   the result of calling it with `props`. If it maps to an object, the
   *   object is returned directly. If nothing is found, `key` is returned.
   */
  get(key: string | string[], props?: object, locale?: string) {
    const lc = locale || String(this.locale);
    let msg = _get(this._data[lc], key);
    if (msg) return typeof msg == 'function' ? msg(props) : msg;
    const fb = this.getFallback(lc);
    for (let i = 0; i < fb.length; ++i) {
      msg = _get(this._data[fb[i]], key);
      if (msg) return typeof msg == 'function' ? msg(props) : msg;
    }
    return key;
  }
}

/** @private */
function _get(
  obj: MessageData | MessageFunction | string,
  key: string | string[]
) {
  if (!obj) return null;
  let res: MessageData | MessageFunction | string = obj;
  if (Array.isArray(key)) {
    for (let i = 0; i < key.length; ++i) {
      if (typeof res !== 'object') return null;
      res = res[key[i]];
      if (!res) return null;
    }
    return res;
  }
  return typeof res === 'object' ? res[key] : null;
}

/** @private */
function _has(
  data: MessageData,
  lc: string,
  key: string | string[],
  fallback: string[] | null,
  type: 'function' | 'object'
) {
  let msg = _get(data[lc], key);
  if (msg) return typeof msg === type;
  if (fallback) {
    for (let i = 0; i < fallback.length; ++i) {
      msg = _get(data[fallback[i]], key);
      if (msg) return typeof msg === type;
    }
  }
  return false;
}
