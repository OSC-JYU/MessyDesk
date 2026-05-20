# MessyDesk

## Digital Humanities Desktop

This is a VERY early version of MessyDesk, a digital humanities desktop (for humanists).

The idea is that you can collect, organise and process your materials easily by experimenting with different kind of options.


![UI](https://github.com/OSC-JYU/MessyDesk/blob/main/docs/messydesk-ui-close.png)

Things you can do:
- extract images and text from PDF
- process images
- do optical character recognition
- do different kind of text and images analysis
- and so on... 

### status

Development in progress.

### Help And Tutorial Pages

Help content lives in `docs/help/*.md` and is converted to HTML for the UI/backend help endpoint.

Help images should be stored in `docs/images`. In help markdown, you can reference image files by bare filename (for example `![Diagram](input_output.png)`), and the build will resolve them automatically.

Build help pages with:

```bash
npm run build:help
```

Generated files are written to `public/help` and served by `GET /api/help/{slug?}`.


### How does it work?

MessyDesk provides intuitive user interface for rapid testing of different kind of services. Services run locally, in nomad cluster or externally. 

### Service adapters

Service adapters are links between MessyDesk backend and services. They translates requests from MessyDesk to the API that service implements. 







