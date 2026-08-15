export const basePath = typeof __TURNFOLD_BASE_PATH__ !== "undefined" ? __TURNFOLD_BASE_PATH__ : "";
export const homeUrl = typeof __TURNFOLD_HOME_URL__ !== "undefined" ? __TURNFOLD_HOME_URL__ : "/";
export const appUrl = (pathname: string) => `${basePath}${pathname}`;
export const mathJaxAssetPath = `${basePath}/assets/mathjax/4.1.3`;
