/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as calendarData from "../calendarData.js";
import type * as databases from "../databases.js";
import type * as events from "../events.js";
import type * as files from "../files.js";
import type * as lib_defaults from "../lib/defaults.js";
import type * as lib_scheduler from "../lib/scheduler.js";
import type * as lib_types from "../lib/types.js";
import type * as pages from "../pages.js";
import type * as pm from "../pm.js";
import type * as rows from "../rows.js";
import type * as scheduling from "../scheduling.js";
import type * as search from "../search.js";
import type * as seed from "../seed.js";
import type * as settings from "../settings.js";
import type * as timeBlocks from "../timeBlocks.js";
import type * as views from "../views.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  calendarData: typeof calendarData;
  databases: typeof databases;
  events: typeof events;
  files: typeof files;
  "lib/defaults": typeof lib_defaults;
  "lib/scheduler": typeof lib_scheduler;
  "lib/types": typeof lib_types;
  pages: typeof pages;
  pm: typeof pm;
  rows: typeof rows;
  scheduling: typeof scheduling;
  search: typeof search;
  seed: typeof seed;
  settings: typeof settings;
  timeBlocks: typeof timeBlocks;
  views: typeof views;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
