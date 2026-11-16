// PreExam waits on this while an update is downloading
let updating = false;

export function setUpdating(value: boolean) {
  updating = value;
}

export function isUpdating() {
  return updating;
}
