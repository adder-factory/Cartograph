import router from '@ohos.router';

@Component
struct CounterView {
  @State count: number = 0;

  build() {
    Button('Tap').onClick(() => {
      this.increment();
      router.pushUrl({ url: 'pages/Next' });
    });
  }

  increment(): void {
    this.count += 1;
  }
}

class WorkerService {
  run(): void {
    new Worker().start();
  }
}
