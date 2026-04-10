export function renderMetricTopic(
  template: string,
  metric: string,
  context = "default",
): string {
  return template
    .replaceAll("{metric}", metric)
    .replaceAll("{context}", context);
}
