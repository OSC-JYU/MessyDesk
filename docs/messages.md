# NATS messages

Message is the core component of MessyDesk.  

Messages send to NATS stream includes:

- id = stream name
- task = service task name
- userId = user who is sending request
- target = which file should be processed
- file = filenode content 
- params = parameters for task

## example message


    {
        service: {
            id: 'md-thumbnailer'
        },
        task: {
            id: 'thumbnail'
            params: { width: 800, type: 'jpeg', size: 200 }
        }
        file: {
            '@rid': '#31:8',
            '@type': 'File',
            type: 'image',
            extension: 'jpg',
            label: 'IMG_3469.JPG',
            _active: true,
            path: 'data/projects/73_1/files/31_8/31_8.jpg'
        },
        userId: 'local.user@localhost',
    }



Real example:

{
  service: {
    local_url: 'http://localhost:9009',
    id: 'md-gensim',
    type: 'text',
    adapter: 'elg',
    api: '/api',
    name: 'Gensim NLP',
    source_url: 'https://github.com/piskvorky/gensim',
    status: 'experimental',
    description: 'Gensim is a Python library for topic modelling, document indexing and similarity retrieval with large corpora. Target audience is the natural language processing (NLP) and information retrieval (IR) community.',
    tasks: { bow: [Object], similarity: [Object], similarity_query: [Object] },
    path: 'services/md-gensim',
    consumers: [ '1615e530-e3d3-4c1f-95fe-af96b7bb0964' ],
    url: '',
    nomad: false
  },
  task: {
    service: 'md-gensim',
    id: 'similarity_query',
    params: {
      query: '»Rose rakas», minä vastasin ja laskin kädestäni lusikan, jolla söin pehmeäksi keitettyä kananmunaa, »mitä ihmettä minun sitten pitäisikään toimittaa?   Pelikehittäjä Valve pudotti pelaajille yllätyksen torstaina, kun se julkaisi päivityksen suosittuun Counter-Strike -videopeliin. Päivitys aiheutti merkittävän romahduksen koko 6 miljardin dollarin arvoisella skinimarkkinalla.  Markkinan arvosta on sulanut yli kolme miljardia euroa, mikä näkyy myös pelaajien skinikokoelmien arvoissa. Monien pelaajien kokoelmat ovat menettäneet arvoaan jopa kymmeniä tuhansia euroja.  Päivityksen myötä pelaajat voivat nyt yhdistää viisi harvinaista aseskiniä ja vaihtaa ne puukoksi tai hanskoiksi. Aiemmin puukkoja ja hanskoja sai vain ostamalla tai yllätyslaatikkoja avaamalla.  Tämän kautta toivoimme Michaelin säntäävän raivostuneena ulos viereisistä huoneistaan ja lankeavan elävänä Saptin käsiin.'
    },
    info: 'Query Similarity Index',
    name: 'Query Similarity Index'
  },
  file: {
    '@rid': '#82:39120',
    '@type': 'File',
    extension: 'json',
    expand: false,
    description: '',
    _active: true,
    label: '118_129175.similarity_results.json',
    type: 'similarity_results.json',
    info: 'dictionary.dict000064400570200000144000011455221510041367101...',
    path: 'data/messydesk/projects/10_9/files/76_41162/process/100_112824/files/82_39120/82_39120.tar',
    metadata: { size: 213.28 },
    '@cat': 'v',
    source: {
      '@rid': '#76:41162',
      '@type': 'File',
      extension: 'txt',
      expand: false,
      metadata: [Object],
      original_filename: 'zenda.txt',
      description: '',
      _active: true,
      label: 'zenda.txt',
      type: 'text',
      info: 'Anthony Hopen Zenda vanki on Projekti Lönnrotin julkaisu no 3224.\n' +
        'E-kirja on public domainissa sekä EUssa että sen ulkopuolella, joten\n' +
        'emme aseta ...',
      path: 'data/messydesk/projects/10_9/files/76_41162/76_41162.txt',
      '@cat': 'v'
    }
  },
  process: {
    '@rid': '#118:129175',
    '@type': 'Process',
    '@cat': 'v',
    task: 'similarity_query',
    service: 'Gensim NLP',
    service_id: 'md-gensim',
    active: true,
    label: 'Query Similarity Index',
    info: 'Query Similarity Index',
    path: 'data/messydesk/projects/10_9/files/76_41162/process/100_112824/files/82_39120/process/118_129175/files'
  },
  output_set: null,
  userId: '#49:0',
  response: { time: 3.651 },
  file_total: 1,
  file_count: 1
}

