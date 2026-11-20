# tags

We need to change tag system a  little bit.

1. Project spesific tags (human created tags)

- Tags should be desk (project) spesific. So when you start a new Desk, you have no tags.
- User should be able to import tags from other desk (user created task). Then tags are shared (i.e. tag in different projects is same tag with same id)

- In global tags view (when user is not in any desk) all tags are shown. 
- There should be similar context 

- Machine created tags already are project related indirectly.

2. tag filter

- User should be able to use all tags (of thah project) in filter whether is is machine generated or human generated.
- for example, use should be able to filter by detected language.
- maybe tags could be shown similarly than in tag view, but in more compact form.
- note that there can be lot of tags, for example NER can produce hundreds of tags.


3. tag admin view

- tag view should have button for tag admin
- tag admin user can create tags/delete/rename tags
- delete and rename are risky operations and user should be warned.
- tag import from other desk should be here



We do not need care about backwards compability!