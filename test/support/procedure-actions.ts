// The Action of a Procedure with id `id`, so a case edits it by name and not by its index. A missing id fails the case.
export function actionById<Action extends { id: string }>(procedure: { actions: Action[] }, id: string): Action {
  const action = procedure.actions.find((candidate) => candidate.id === id);
  if (!action)
    throw new Error(`the Procedure has no Action ${id}: ${procedure.actions.map((other) => other.id).join(', ')}`);
  return action;
}

// Puts `action` where the Action of a Procedure with id `id` stood, replacing that Action and every key it declared.
export function replaceAction<Action extends { id: string }>(
  procedure: { actions: Action[] },
  id: string,
  action: Action,
): void {
  procedure.actions[procedure.actions.indexOf(actionById(procedure, id))] = action;
}
