const noop = () => {};
export const useEffect = noop, useState = (v: unknown) => [v, noop], useMemo = (f: () => unknown) => f(), useCallback = (f: unknown) => f, useRef = (v: unknown) => ({ current: v }), useSyncExternalStore = noop, createContext = () => ({}), useContext = noop, Fragment = {}, StrictMode = {};
export const jsx = noop, jsxs = noop;
export default { useEffect, useState };
