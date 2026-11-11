const test=require('node:test'),assert=require('node:assert/strict');
const D=require('../directory-paths.js');
test('怀宁和库山原目录的共同上级是已有 haibo，单目录和路径前缀保持精确',()=>{
 assert.equal(D.commonAncestor(['/home/lhx/docker/data/haibo/huaining/05/20261106/rtfbag','/home/lhx/docker/data/haibo/kushan/22/20261105/rtfbag']),'/home/lhx/docker/data/haibo');
 assert.equal(D.commonAncestor(['/data/one','/data/one-other']),'/data');assert.equal(D.commonAncestor(['/data/one']),'/data/one');assert.equal(D.commonAncestor([]),'');
});
test('Windows 和 UNC 共同上级忽略大小写；不同盘符不能推测共同目录',()=>{
 assert.equal(D.commonAncestor(['C:\\Data\\A','c:\\Data\\B']),'C:\\Data');assert.equal(D.commonAncestor(['C:\\Data','D:\\Data']),'');
 assert.equal(D.commonAncestor(['\\\\server\\share\\A','\\\\SERVER\\SHARE\\B']),'\\\\server\\share');
});
