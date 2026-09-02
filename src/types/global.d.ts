// Copyright (c) 2026 Sarthak Parulekar
// SPDX-License-Identifier: MIT

import type { WingmanApi } from './contracts';

declare global {
  interface Window {
    wingman: WingmanApi;
  }
}

export {};
