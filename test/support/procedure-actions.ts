// The Action of a Procedure with id `id`, so a case edits it by name and not by its index. A missing id fails the case.
export function actionById<Action extends { id: string }>(procedure: { actions: Action[] }, _id: string): Action {
  return procedure.actions[0] as Action;
}
