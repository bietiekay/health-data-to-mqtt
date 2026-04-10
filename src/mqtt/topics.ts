export function renderMetricTopic(template: string, metric: string): string {
  return template.replaceAll("{metric}", metric);
}
