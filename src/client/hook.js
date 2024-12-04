class HookEvent {
    constructor(data = {}, target = null, that = null) {
        this.intercepted = false;
        this.returnValue = null;
        this.data = data;
        this.target = target;
        this.that = that;
    }

    respondWith(input) {
        this.returnValue = input;
        this.intercepted = true;
    }
}
