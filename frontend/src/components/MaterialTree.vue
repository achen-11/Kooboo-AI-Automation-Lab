<script setup lang="ts">
import { computed } from 'vue';
import { Folder, File, X } from '@lucide/vue';
const props=defineProps<{files:{name:string;id?:string;size?:number}[];removable?:boolean;disabled?:boolean}>();
const emit=defineEmits<{remove:[name:string]}>();
const tree=computed(()=>{const rows:{key:string;name:string;depth:number;folder:boolean;original?:string}[]=[],seen=new Set<string>();for(const f of [...props.files].sort((a,b)=>a.name.localeCompare(b.name))){const parts=f.name.split('/');parts.forEach((name,index)=>{const key=parts.slice(0,index+1).join('/'),folder=index<parts.length-1;if(folder&&seen.has(key))return;seen.add(key);rows.push({key,name,depth:index,folder,original:folder?undefined:f.name});});}return rows;});
</script>
<template><div class="material-tree" role="list"><div v-for="row in tree" :key="row.key+(row.folder?'/':'')" class="material-tree-row" role="listitem" :style="{paddingLeft:`${12+row.depth*18}px`}"><Folder v-if="row.folder" :size="15"/><File v-else :size="15"/><span :title="row.key">{{row.name}}</span><button v-if="removable&&!row.folder" type="button" class="icon-button" :aria-label="`移除 ${row.original}`" :disabled="disabled" @click="emit('remove',row.original!)"><X :size="14"/></button></div></div></template>
<style scoped>.material-tree{max-height:280px;overflow:auto;border:1px solid var(--line);border-radius:8px}.material-tree-row{display:flex;gap:8px;align-items:center;min-height:32px;padding:2px 10px;font-size:13px}.material-tree-row>svg{flex:none;color:var(--muted)}.material-tree-row>span{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.material-tree-row .icon-button{width:26px;height:26px}</style>
