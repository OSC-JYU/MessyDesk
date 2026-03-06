Directory structure TODO

MessyDesk uses graph database for documentating file processing and keeping record of origin of files.

Currently directory structure loosely replicates graph structure which is not ideal. We must implement new structure.
The idea is to make structure simpler but avoid huge directories. Important part of structure is that it must be possible to reconstruct database solely on directory data.

MessyDesk/data remains as data directory. Under that there is database specific directory, which allows experimenting with different databases in same data directory.



New structure is following:

 /files
 /processes
 /sets

## Files

 Under the /files there is a sharding based on Arcadedb's RID values. So file #34:567 

 Here is the function:
 function ridPath(rid) {
  const [bucket, pos] = rid.split(':').map(Number)
  const block = Math.floor(pos / 1000)
  return `${bucket}/${block}/${pos}`
}

That would create:
/files
  /34
    /56
      /567

Actual file and its thumbnails are saved in that directory.


## Process
Process data is saved similarly in /processes


## Sets

/sets are saved differently. Sets are virtual folders that has references to files. Set folder includes JSON file with list of all files in it. 