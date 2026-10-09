import { demoApi } from './demo';
import { httpApi } from './http';

export const isDemo = import.meta.env.VITE_DEMO === '1';
export const api = isDemo ? demoApi : httpApi;
export * from './types';
