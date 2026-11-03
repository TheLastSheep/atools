const VALUE_OPTIONS=new Set(["--build-profile","--evidence-dir"]);
const FLAG_OPTIONS=new Set(["--inventory-logo","--pasteboard-pro-native-image","--image-toolbox-original","--file-tree-head","--developer-codec-tools-head"]);

export function parseNativePanelCliOptions(args) {
  const options={buildProfile:"debug",evidenceDir:null,scenario:"panel",outputPath:null};
  const seen=new Set();
  const positional=[];
  for(let index=0;index<args.length;index++) {
    const arg=args[index];
    if(VALUE_OPTIONS.has(arg)) {
      if(seen.has(arg))throw Error(`${arg} may be supplied only once`);
      seen.add(arg);
      const value=args[++index];
      if(!value||value.startsWith("--"))throw Error(`${arg} requires a value`);
      if(arg==="--build-profile") {
        if(value!=="debug"&&value!=="release")throw Error("Native smoke build profile must be debug or release");
        options.buildProfile=value;
      } else options.evidenceDir=value;
      continue;
    }
    if(FLAG_OPTIONS.has(arg)) {
      if(seen.has(arg))throw Error(`${arg} may be supplied only once`);
      seen.add(arg);
      const selected=arg==="--inventory-logo"?"inventory-logo":arg==="--image-toolbox-original"?"image-toolbox-original":arg==="--file-tree-head"?"file-tree-head":arg==="--developer-codec-tools-head"?"developer-codec-tools-head":"pasteboard-pro-native-image";
      if(options.scenario!=="panel")throw Error("Native panel scenarios are mutually exclusive");
      options.scenario=selected;
      continue;
    }
    if(arg.startsWith("--"))throw Error(`Unknown native panel option: ${arg}`);
    positional.push(arg);
    if(positional.length>1)throw Error("Native panel probe accepts at most one output path");
  }
  options.outputPath=positional[0]??null;
  return options;
}
