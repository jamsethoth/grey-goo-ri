// The Action of a Procedure with id `id`, so a case edits it by name and not by its index. A missing id fails the case.
// Its type is the procedure's Action type, so a Layer parsed from JSON gives an Action a case may edit freely.
export function actionById<Procedure extends { actions: { id: string }[] }>(
  procedure: Procedure,
  id: string,
): Procedure['actions'][number] {
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
