import { createContext, useContext } from "react";

/** Lets any card switch the top-level tab ("overview" or a module id). */
export const NavContext = createContext<{ tab: string; go: (tab: string) => void }>({ tab: "overview", go: () => {} });

export const useNav = () => useContext(NavContext);
