import { AcademyStudentsRepository } from './academy-students.repository';

describe('AcademyStudentsRepository.countActiveForAcademy', () => {
  it('counts only active, unblocked students of the Academy', async () => {
    const count = jest.fn(async () => 4);
    const tx = { academyStudent: { count } };
    const repository = new AcademyStudentsRepository({} as never);

    await expect(
      repository.countActiveForAcademy(tx as never, 'academy-1'),
    ).resolves.toBe(4);
    expect(count).toHaveBeenCalledWith({
      where: { academyId: 'academy-1', status: 'active', blockedAt: null },
    });
  });
});
