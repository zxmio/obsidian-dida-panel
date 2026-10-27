// Obsidian 桌面端自带 electron，插件只用到 shell.openExternal，不为它引整套类型依赖
declare module "electron" {
  export const shell: {
    openExternal(url: string): Promise<void>;
  };
}
