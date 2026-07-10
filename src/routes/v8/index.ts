import { Hono } from 'hono/tiny';

import type { AppBindings } from '../../runtime/app-env';

import { artifactRouter } from './artifacts';

export const v8App = new Hono<{ Bindings: AppBindings }>();

v8App.route('/artifacts', artifactRouter);
