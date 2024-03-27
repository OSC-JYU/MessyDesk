

class Queue {
    constructor(fn) {
      this.items = [];
      this.running = false;
      this.callback = fn
    }
  
    add(service, data, filenode) {
        console.log('item to queue:')
        console.log(item)
        var item = {service: service, data: data}
        if(filenode) item.filenode = filenode
      this.items.push(item);
      if (!this.running) {
        this.process();
      }
    }
  
    async process() {
      if (this.items.length === 0) {
        this.running = false;
        return;
      }
  
      this.running = true;
      const item = this.items.shift();
      try {
        await this.run(item);
        this.process();
      } catch(e) {
        this.items.unshift(item);
        //throw(e)
      }
      // Continue processing next item
    }
  
    async run(item) {
      // do actual processing
      console.log('item from queue:')
      console.log(item)
      try {
        await this.callback(item);
        console.log('done')
      } catch(e) {
        console.log('Queue item processing failed!')
        console.log(e)
        throw(e)
      }

    }
  }

  module.exports = Queue;