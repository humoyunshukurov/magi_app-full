// App.tsx's update check downloads in the background rather than blocking the UI, so without
// this a student could start an exam mid-download and get pulled into a relaunch partway
// through it. PreExam's environment check reads this to hold the exam back until it's done.
let updating = false;

export function setUpdating(value: boolean) {
  updating = value;
}

export function isUpdating() {
  return updating;
}
