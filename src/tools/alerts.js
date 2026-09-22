import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/alerts.js';

export function registerAlertTools(server) {
  server.tool('alert_create', 'Create a price alert on the current chart symbol via TradingView\'s alert API', {
    condition: z.string().describe('Alert condition: "crossing", "greater_than", or "less_than"'),
    price: z.coerce.number().describe('Price level for the alert'),
    message: z.string().optional().describe('Alert message'),
  }, async ({ condition, price, message }) => {
    try { return jsonResult(await core.create({ condition, price, message })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('alert_list', 'List active alerts', {}, async () => {
    try { return jsonResult(await core.list()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('alert_delete', 'Delete a specific alert by id, or all active alerts', {
    alert_id: z.coerce.number().optional().describe('Alert id to delete (from alert_list)'),
    delete_all: z.coerce.boolean().optional().describe('Delete all active alerts'),
  }, async ({ alert_id, delete_all }) => {
    try { return jsonResult(await core.deleteAlerts({ alert_id, delete_all })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  const studyConditionSchema = z.enum(['cross_up', 'cross_down', 'cross', 'greater', 'less']);
  const frequencySchema = z.enum(['on_bar_close', 'on_first_fire', 'once_per_minute'])
    .describe('Trigger frequency (default on_bar_close)');

  server.tool('alert_create_study', 'Create an indicator-condition alert on a plot of a Pine study on the current chart. dry_run defaults to true and returns the exact payload without sending', {
    study_id: z.string().describe('Study entity id from chart_get_state (e.g. "JJayFq")'),
    plot: z.string().describe('Plot title as data_get_study_values shows it (e.g. "volatility percentile"), or a plot id like "plot_0"'),
    condition: studyConditionSchema.describe('How the plot is compared with value'),
    value: z.coerce.number().describe('Level the plot is compared against'),
    frequency: frequencySchema.optional(),
    resolution: z.string().optional().describe('Alert timeframe, e.g. "60", "240", "1D" (default: the chart\'s)'),
    message: z.string().optional().describe('Alert message'),
    dry_run: z.boolean().optional().describe('true (default): return the payload without sending. false: create the alert and return its alert_id'),
  }, async ({ study_id, plot, condition, value, frequency, resolution, message, dry_run }) => {
    try { return jsonResult(await core.createStudyAlert({ study_id, plot, condition, value, frequency, resolution, message, dry_run })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('alert_update', 'Update an existing alert by id, changing only the supplied fields. dry_run defaults to true and returns the current alert plus the exact requests without sending', {
    alert_id: z.coerce.number().describe('Alert id (from alert_list)'),
    condition: studyConditionSchema.optional().describe('New condition (only for cross/cross_up/cross_down/greater/less alerts)'),
    value: z.coerce.number().optional().describe('New comparison value'),
    frequency: frequencySchema.optional(),
    resolution: z.string().optional().describe('New alert timeframe, e.g. "60", "1D"'),
    message: z.string().optional().describe('New alert message'),
    active: z.boolean().optional().describe('true: restart the alert. false: stop it'),
    dry_run: z.boolean().optional().describe('true (default): return the planned requests without sending. false: apply them and return before/after'),
  }, async ({ alert_id, condition, value, frequency, resolution, message, active, dry_run }) => {
    try { return jsonResult(await core.updateAlert({ alert_id, condition, value, frequency, resolution, message, active, dry_run })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
}
