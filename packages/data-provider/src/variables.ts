export const specialVariables = {
  current_date: true,
  current_user: true,
  iso_datetime: true,
  current_datetime: true,
  current_model: true,
};

/** Recognises built-in context variables, ignoring case and surrounding whitespace. */
export function getSpecialVariable(variable: string): keyof typeof specialVariables | undefined {
  const key = variable.trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(specialVariables, key)
    ? (key as keyof typeof specialVariables)
    : undefined;
}
