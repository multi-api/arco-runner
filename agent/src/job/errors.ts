export class BuildFailure extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'BuildFailure';
  }
}
