import type { WingmanApi } from './contracts';

declare global {
  interface Window {
    wingman: WingmanApi;
  }
}

export {};
